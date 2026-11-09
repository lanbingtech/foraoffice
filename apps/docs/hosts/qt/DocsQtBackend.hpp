#pragma once

#include <QHash>
#include <QJsonObject>
#include <QObject>
#include <QSet>
#include <atomic>
#include <memory>

class QProcess;
class QTimer;

namespace foraoffice {

using DocsQtRequestLifetime = std::shared_ptr<std::atomic_bool>;

/** Internal worker. All process, protocol and timer operations run in its owning thread. */
class DocsQtBackend final : public QObject {
    Q_OBJECT
public:
    DocsQtBackend(QString node, QString entry, QJsonObject options);
    void start();
    void send(const QJsonObject& message);
    void stop();
signals:
    void initialized(QJsonObject assets);
    void received(QJsonObject message, foraoffice::DocsQtRequestLifetime lifetime);
    void failed(QString message);
    void stopped();
private:
    void readOutput();
    void receive(const QJsonObject& message);
    void write(const QJsonObject& message);
    void fail(const QString& message);
    void invalidateRequests();
    void finish();
    QString node_;
    QString entry_;
    QJsonObject options_;
    QProcess* process_ = nullptr;
    QTimer* startupTimer_ = nullptr;
    QTimer* shutdownTimer_ = nullptr;
    QByteArray output_;
    QString initializeId_;
    QSet<QString> pending_;
    struct Request {
        QString sourceId;
        DocsQtRequestLifetime lifetime;
    };
    QHash<QString, Request> requests_;
    QHash<QString, QString> requestIds_;
    bool ready_ = false;
    bool stopping_ = false;
    bool finished_ = false;
    int stopStage_ = 0;
};

} // namespace foraoffice

Q_DECLARE_METATYPE(foraoffice::DocsQtRequestLifetime)
