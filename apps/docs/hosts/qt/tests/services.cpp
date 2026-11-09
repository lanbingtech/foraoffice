#include "DocsQtEditor.hpp"
#include <QApplication>
#include <QJsonDocument>
#include <QTemporaryDir>
#include <QTimer>
#include <QtTest>

class ServiceTests final : public QObject {
    Q_OBJECT
private slots:
    void hostOverridesAreAuthoritativeAndUnconfiguredServicesKeepDefaults() {
        QTemporaryDir directory;
        foraoffice::DocsQtOptions options;
        options.packageRoot = qEnvironmentVariable("FORAOFFICE_QT_TEST_PACKAGE");
        options.nodeExecutable = qEnvironmentVariable("FORAOFFICE_QT_TEST_NODE");
        options.stateDirectory = directory.path();
        options.language = "en";
        options.documentHost = {{"enabled", true}};
        foraoffice::DocsQtEditor editor(options);
        auto* channel = editor.findChild<foraoffice::DocsQtChannel*>();
        QVERIFY(channel);
        QSignalSpy replies(channel, &foraoffice::DocsQtChannel::reply);
        int calls = 0;
        editor.setServiceHandler("openDocx", [&](const QJsonArray&, foraoffice::DocsQtEditor::Completion done) {
            calls++;
            done({{"result", QJsonValue::Null}});
        });
        const auto request = [&](const QString& method) {
            channel->request(QString::fromUtf8(QJsonDocument(QJsonObject{{"jsonrpc", "2.0"}, {"id", "test"},
                {"method", "services.call"}, {"params", QJsonObject{{"method", method}, {"args", QJsonArray{}}}}}).toJson()));
        };
        request("openDocx");
        QCOMPARE(calls, 1);
        QCOMPARE(replies.size(), 1);
        QVERIFY(QJsonDocument::fromJson(replies.takeFirst()[0].toString().toUtf8()).object().value("result").isNull());
        editor.setServiceEnabled("openDocx", false);
        request("openDocx");
        QCOMPARE(calls, 1);
        QVERIFY(QJsonDocument::fromJson(replies.takeFirst()[0].toString().toUtf8()).object().contains("error"));
        editor.setServiceEnabled("openDocx", true);
        editor.setServiceHandler("openDocx", [](const QJsonArray&, foraoffice::DocsQtEditor::Completion done) {
            done({{"error", QJsonObject{{"message", "Host storage failed"}}}});
        });
        request("openDocx");
        QVERIFY(QJsonDocument::fromJson(replies.takeFirst()[0].toString().toUtf8()).object().contains("error"));
        request("getLanguage");
        QCOMPARE(QJsonDocument::fromJson(replies.takeFirst()[0].toString().toUtf8()).object().value("result").toString(), QStringLiteral("en"));
        request("createDocument");
        const auto refused = QJsonDocument::fromJson(replies.takeFirst()[0].toString().toUtf8()).object();
        QCOMPARE(refused.value("error").toObject().value("data").toObject().value("errorCode").toString(), QStringLiteral("unavailable"));
    }
};

int main(int argc, char** argv) {
    foraoffice::DocsQtEditor::registerUrlSchemes();
    QApplication app(argc, argv);
    ServiceTests tests;
    const auto result = QTest::qExec(&tests, argc, argv);
    QTimer::singleShot(0, &app, &QCoreApplication::quit);
    app.exec();
    return result;
}
#include "services.moc"
