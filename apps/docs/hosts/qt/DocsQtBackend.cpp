#include "DocsQtBackend.hpp"
#include <QFileInfo>
#include <QJsonDocument>
#include <QProcess>
#include <QThread>
#include <QTimer>
#include <QUuid>
#include <utility>
#ifdef Q_OS_WIN
#include <qt_windows.h>
#endif

namespace foraoffice {
namespace {
QJsonObject errorReply(const QString& id, const QString& message) {
    return {{"jsonrpc", "2.0"}, {"id", id},
            {"error", QJsonObject{{"code", -32000}, {"message", message}}}};
}
}

DocsQtBackend::DocsQtBackend(QString node, QString entry, QJsonObject options)
    : node_(std::move(node)), entry_(std::move(entry)), options_(std::move(options)) {}

void DocsQtBackend::start() {
    Q_ASSERT(QThread::currentThread() == thread());
    if (stopping_ || process_) return;
    if (!QFileInfo::exists(entry_) || !QFileInfo::exists(node_)) {
        fail(tr("The packaged document backend or Node executable is missing."));
        return;
    }
    process_ = new QProcess(this);
    startupTimer_ = new QTimer(this);
    startupTimer_->setSingleShot(true);
    connect(startupTimer_, &QTimer::timeout, this, [this] {
        fail(tr("The independent document backend initialization timed out."));
    });
    shutdownTimer_ = new QTimer(this);
    shutdownTimer_->setSingleShot(true);
    connect(shutdownTimer_, &QTimer::timeout, this, [this] {
        if (process_->state() == QProcess::NotRunning) { finish(); return; }
        if (stopStage_++ == 0) {
            process_->terminate();
            shutdownTimer_->start(2000);
        } else {
            process_->kill();
        }
    });
    connect(process_, &QProcess::readyReadStandardOutput, this, &DocsQtBackend::readOutput);
    connect(process_, &QProcess::readyReadStandardError, this, [this] { process_->readAllStandardError(); });
    connect(process_, &QProcess::started, this, [this] {
        if (stopping_) { process_->closeWriteChannel(); return; }
        initializeId_ = QUuid::createUuid().toString(QUuid::WithoutBraces);
        write({{"jsonrpc", "2.0"}, {"id", initializeId_}, {"method", "initialize"}, {"params", options_}});
    });
    connect(process_, &QProcess::errorOccurred, this, [this](QProcess::ProcessError error) {
        if (!stopping_) fail(tr("The independent document backend could not run."));
        if (error == QProcess::FailedToStart) finish();
    });
    connect(process_, &QProcess::finished, this, [this](int, QProcess::ExitStatus) {
        if (!stopping_) fail(tr("The independent document backend disconnected."));
        finish();
    });
#ifdef Q_OS_WIN
    process_->setCreateProcessArgumentsModifier([](QProcess::CreateProcessArguments* arguments) {
        arguments->flags |= CREATE_NO_WINDOW;
    });
#endif
    startupTimer_->start(30000);
    process_->start(node_, {entry_});
}

void DocsQtBackend::write(const QJsonObject& message) {
    if (process_ && process_->state() == QProcess::Running)
        process_->write(QJsonDocument(message).toJson(QJsonDocument::Compact) + '\n');
}

void DocsQtBackend::send(const QJsonObject& message) {
    Q_ASSERT(QThread::currentThread() == thread());
    const auto id = message.value("id").toString();
    const bool request = message.contains("method");
    if (stopping_ || !ready_) {
        if (request && !id.isEmpty()) emit received(errorReply(id, tr("The document backend is unavailable or busy.")), {});
        return;
    }
    auto forwarded = message;
    if (!request) {
        const auto original = requests_.take(id);
        if (!original.lifetime || !original.lifetime->exchange(false)) return;
        requestIds_.remove(original.sourceId);
        forwarded.insert("id", original.sourceId);
    } else if (!id.isEmpty()) {
        if (pending_.size() >= 64 || pending_.contains(id)) {
            emit received(errorReply(id, tr("The document backend is unavailable or busy.")), {});
            return;
        }
        pending_.insert(id);
    }
    write(forwarded);
}

void DocsQtBackend::readOutput() {
    const auto bytes = process_->readAllStandardOutput();
    if (stopping_) return;
    output_ += bytes;
    if (output_.size() > 80 * 1024 * 1024) {
        fail(tr("The document backend response exceeded its limit."));
        return;
    }
    qsizetype newline;
    while (!stopping_ && (newline = output_.indexOf('\n')) >= 0) {
        const auto line = output_.left(newline);
        output_.remove(0, newline + 1);
        QJsonParseError error;
        const auto document = QJsonDocument::fromJson(line, &error);
        if (error.error != QJsonParseError::NoError || !document.isObject()) {
            fail(tr("Invalid document backend response."));
            return;
        }
        receive(document.object());
    }
}

void DocsQtBackend::receive(const QJsonObject& message) {
    if (message.value("jsonrpc") != "2.0") { fail(tr("Invalid document backend protocol.")); return; }
    const auto id = message.value("id").toString();
    const auto method = message.value("method").toString();
    if (method.isEmpty()) {
        if (!ready_ && id == initializeId_) {
            if (message.contains("error")) {
                fail(message.value("error").toObject().value("message").toString());
                return;
            }
            const auto assets = message.value("result").toObject().value("assets").toObject();
            if (assets.value("url").toString().isEmpty() || assets.value("token").toString().isEmpty()) {
                fail(tr("Invalid document backend response."));
                return;
            }
            startupTimer_->stop();
            ready_ = true;
            emit initialized(assets);
        } else if (pending_.remove(id)) emit received(message, {});
        return;
    }
    auto forwarded = message;
    if (method == "host.cancel") {
        auto params = message.value("params").toObject();
        const auto internalId = requestIds_.take(params.value("id").toString());
        const auto canceled = requests_.take(internalId);
        if (canceled.lifetime) canceled.lifetime->store(false);
        params.insert("id", internalId);
        forwarded.insert("params", params);
    }
    DocsQtRequestLifetime lifetime;
    if (!id.isEmpty()) {
        if (requestIds_.contains(id)) { fail(tr("Invalid document backend protocol.")); return; }
        lifetime = std::make_shared<std::atomic_bool>(true);
        // GUI continuations may outlive cancellation and a reused backend JSON-RPC id.
        const auto internalId = QUuid::createUuid().toString(QUuid::WithoutBraces);
        requests_.insert(internalId, {id, lifetime});
        requestIds_.insert(id, internalId);
        forwarded.insert("id", internalId);
    }
    emit received(forwarded, lifetime);
}

void DocsQtBackend::invalidateRequests() {
    for (const auto& request : std::as_const(requests_)) request.lifetime->store(false);
    requests_.clear();
    requestIds_.clear();
}

void DocsQtBackend::fail(const QString& message) {
    if (stopping_) return;
    invalidateRequests();
    const auto pending = std::exchange(pending_, {});
    for (const auto& id : pending) emit received(errorReply(id, message), {});
    emit failed(message);
    stop();
}

void DocsQtBackend::stop() {
    Q_ASSERT(QThread::currentThread() == thread());
    if (stopping_) return;
    stopping_ = true;
    ready_ = false;
    output_.clear();
    invalidateRequests();
    pending_.clear();
    if (startupTimer_) startupTimer_->stop();
    if (!process_ || process_->state() == QProcess::NotRunning) { finish(); return; }
    process_->closeWriteChannel();
    shutdownTimer_->start(5000);
}

void DocsQtBackend::finish() {
    if (finished_) return;
    finished_ = true;
    if (startupTimer_) startupTimer_->stop();
    if (shutdownTimer_) shutdownTimer_->stop();
    invalidateRequests();
    emit stopped();
}

} // namespace foraoffice
