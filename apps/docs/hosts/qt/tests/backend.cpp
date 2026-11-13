#include "DocsQtBackend.hpp"
#include <QCoreApplication>
#include <QElapsedTimer>
#include <QFile>
#include <QJsonArray>
#include <QTemporaryDir>
#include <QThread>
#include <QtTest>
#include <atomic>
#include <chrono>

class BackendHarness final : public QObject {
    Q_OBJECT
public:
    QThread thread;
    QTemporaryDir directory;
    foraoffice::DocsQtBackend* backend;
    QList<QJsonObject> messages;
    QList<foraoffice::DocsQtRequestLifetime> lifetimes;
    QStringList failures;
    std::atomic_bool initialized{false};
    std::atomic_bool initializedOnWorker{false};
    std::atomic<qint64> initializedAtNs{0};

    explicit BackendHarness(const QString& script) {
        QFile entry(directory.filePath("backend.cjs"));
        if (!entry.open(QIODevice::WriteOnly) || entry.write(script.toUtf8()) < 0) qFatal("Cannot write fixture");
        entry.close();
        backend = new foraoffice::DocsQtBackend(qEnvironmentVariable("FORAOFFICE_QT_TEST_NODE"), entry.fileName(), {});
        backend->moveToThread(&thread);
        connect(&thread, &QThread::started, backend, &foraoffice::DocsQtBackend::start);
        connect(this, &BackendHarness::send, backend, &foraoffice::DocsQtBackend::send, Qt::QueuedConnection);
        connect(this, &BackendHarness::stop, backend, &foraoffice::DocsQtBackend::stop, Qt::QueuedConnection);
        connect(backend, &foraoffice::DocsQtBackend::stopped, &thread, &QThread::quit, Qt::DirectConnection);
        connect(&thread, &QThread::finished, backend, &QObject::deleteLater);
        connect(backend, &foraoffice::DocsQtBackend::initialized, backend, [this] {
            initializedOnWorker.store(QThread::currentThread() == &thread);
            initializedAtNs.store(std::chrono::steady_clock::now().time_since_epoch().count());
            initialized.store(true);
        });
        connect(backend, &foraoffice::DocsQtBackend::received, this,
            [this](QJsonObject message, foraoffice::DocsQtRequestLifetime lifetime) {
                messages.append(message);
                lifetimes.append(lifetime);
            });
        connect(backend, &foraoffice::DocsQtBackend::failed, this, [this](QString error) { failures.append(error); });
    }
    ~BackendHarness() override {
        emit stop();
        if (!thread.wait(10000)) qFatal("Fixture backend did not stop");
    }
signals:
    void send(QJsonObject message);
    void stop();
};

class BackendTests final : public QObject {
    Q_OBJECT
    const QString fixture = QStringLiteral(
        "const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});"
        "const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');"
        "rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize'){"
        "send({id:m.id,result:{assets:{url:'http://127.0.0.1/asset',token:'fixture'}}});%1"
        "}else{%2}});rl.on('close',()=>process.exit(0));");
private slots:
    void initializationReplyIsHandledOnWorkerWhileGuiIsPaused() {
        BackendHarness host(fixture.arg("", ""));
        const auto begin = std::chrono::steady_clock::now().time_since_epoch().count();
        host.thread.start();
        QElapsedTimer elapsed;
        elapsed.start();
        while (!host.initialized.load() && elapsed.elapsed() < 5000) QThread::msleep(10);
        const auto resume = std::chrono::steady_clock::now().time_since_epoch().count();
        QVERIFY(host.initialized.load());
        QVERIFY(host.initializedOnWorker.load());
        QVERIFY(host.initializedAtNs.load() >= begin && host.initializedAtNs.load() <= resume);
    }
    void cancellationAndReusedIdsRejectLateReplies() {
        BackendHarness host(fixture.arg(
            "send({id:'reused',method:'editor.request',params:{version:'old'}});"
            "send({method:'host.cancel',params:{id:'reused'}});"
            "send({id:'reused',method:'editor.request',params:{version:'new'}});",
            "send({method:'fixture.reply',params:m});"));
        host.thread.start();
        QTRY_COMPARE(host.messages.size(), 3);
        QVERIFY(host.lifetimes[0] && !host.lifetimes[0]->load());
        QVERIFY(host.lifetimes[2] && host.lifetimes[2]->load());
        emit host.send({{"jsonrpc", "2.0"}, {"id", host.messages[0].value("id")}, {"result", "old"}});
        emit host.send({{"jsonrpc", "2.0"}, {"id", host.messages[2].value("id")}, {"result", "new"}});
        QTRY_COMPARE(host.messages.size(), 4);
        const auto response = host.messages[3].value("params").toObject();
        QCOMPARE(response.value("id").toString(), QStringLiteral("reused"));
        QCOMPARE(response.value("result").toString(), QStringLiteral("new"));
    }
    void malformedOutputStopsTheOwnedProcess() {
        BackendHarness host(fixture.arg("process.stdout.write('invalid-json\\n');", ""));
        host.thread.start();
        QTRY_VERIFY(!host.failures.isEmpty());
        QVERIFY(host.thread.wait(10000));
        QCOMPARE(host.failures.size(), 1);
    }
    void closeDuringInitializationNeedsNoGuiCallbacks() {
        BackendHarness host(QStringLiteral("process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"));
        host.thread.start();
        emit host.stop();
        QVERIFY(host.thread.wait(10000));
        QVERIFY(!host.initialized.load());
    }
    void crashFailsPendingRequestAndInvalidatesQueuedGuiWork() {
        BackendHarness host(fixture.arg("send({id:'view',method:'editor.request',params:{}});",
            "if(m.method==='crash')process.exit(1);"));
        host.thread.start();
        QTRY_VERIFY(host.initialized.load());
        QTRY_COMPARE(host.messages.size(), 1);
        emit host.send({{"jsonrpc", "2.0"}, {"id", "pending"}, {"method", "crash"}, {"params", QJsonObject{}}});
        QTRY_VERIFY(!host.failures.isEmpty());
        QTRY_COMPARE(host.messages.size(), 2);
        QVERIFY(!host.lifetimes[0]->load());
        QCOMPARE(host.messages[1].value("id").toString(), QStringLiteral("pending"));
        QVERIFY(host.messages[1].contains("error"));
        QVERIFY(host.thread.wait(10000));
    }
    void ignoresShutdownOutputAndKillsAnUnresponsiveProcess() {
        BackendHarness host(fixture.arg(
            "rl.removeAllListeners('close');process.stdin.resume();"
            "setInterval(()=>process.stdout.write('x'.repeat(16384)),1);", ""));
        host.thread.start();
        QTRY_VERIFY(host.initialized.load());
        emit host.stop();
        QVERIFY(host.thread.wait(10000));
        QVERIFY(host.failures.isEmpty());
    }
};

QTEST_GUILESS_MAIN(BackendTests)
#include "backend.moc"
