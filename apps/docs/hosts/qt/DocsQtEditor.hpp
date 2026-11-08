#pragma once

#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QJsonValue>
#include <QProcess>
#include <QSet>
#include <QWidget>
#include <functional>

class QLabel;
class QTimer;
class QWebEngineProfile;
class QWebEngineView;

namespace foraoffice {
class DocsQtPrinting;

struct DocsQtOptions {
    QString packageRoot;
    QString nodeExecutable;
    QString stateDirectory;
    QStringList readRoots;
    QStringList writeRoots;
    QString defaultSaveDirectory;
    QString initialPath;
    QJsonObject initialContent;
    QStringList attachments;
    QStringList knowledge;
    QString language = QStringLiteral("zh");
};

class DocsQtEditor;

class DocsQtChannel final : public QObject {
    Q_OBJECT
public:
    explicit DocsQtChannel(DocsQtEditor& editor);
    Q_INVOKABLE void request(const QString& message);
    Q_INVOKABLE void complete(const QString& message);
signals:
    void reply(QString message);
    void command(QString message);
    void event(QString name, QString arguments);
private:
    DocsQtEditor& editor_;
};

/** Native Docs container; document processing is in the SDK and owned Node service. */
class DocsQtEditor final : public QWidget {
    Q_OBJECT
public:
    using Completion = std::function<void(const QJsonObject&)>;
    using ActionHandler = std::function<void(const QJsonObject& action,
                                             const QJsonObject& grant, Completion done)>;
    using CreateWordHandler = std::function<void(const QJsonObject& content, Completion done)>;
    using OpenFileHandler = std::function<bool(const QString& path)>;
    /** Call before constructing QApplication, as required by Qt WebEngine. */
    static void registerUrlSchemes();
    explicit DocsQtEditor(DocsQtOptions options, QWidget* parent = nullptr);
    ~DocsQtEditor() override;
    QWebEngineView* view() const { return view_; }
    void setActionHandler(ActionHandler handler) { actionHandler_ = std::move(handler); }
    void setCreateWordHandler(CreateWordHandler handler) { createWordHandler_ = std::move(handler); }
    void setOpenFileHandler(OpenFileHandler handler) { openFileHandler_ = std::move(handler); }
    /** Trusted native menu entry; uses the editor's existing manual command handler. */
    void triggerMenuCommand(const QString& command, const QString& payload = {});
    QString nativeText(const QString& key) const;
signals:
    void ready();
    void failed(QString message);
    void documentCreated(QJsonObject outcome);
protected:
    void closeEvent(QCloseEvent* event) override;
private:
    friend class DocsQtChannel;
    void fromRenderer(const QString& source);
    void fromRendererResult(const QString& source);
    void backendMessage(const QJsonObject& message);
    void sendBackend(const QJsonObject& message);
    void backendCall(const QString& method, const QJsonObject& params, Completion done);
    void rendererReply(const QJsonValue& id, const QJsonValue& result);
    void rendererError(const QJsonValue& id, const QString& message, const QJsonObject& errorData = {});
    void hostEvent(const QString& name, const QJsonArray& args = {});
    void serviceCall(const QJsonValue& id, const QString& method, const QJsonArray& args);
    void serviceNotify(const QString& method, const QJsonArray& args);
    void fail(const QString& message);
    void stopBackend();
    void acceptClose();
    void checkDocumentClose(std::function<void(bool)> done);
    void resolveCloseCheck(bool allowed);
    void requestCloseState();
    DocsQtOptions options_;
    QJsonObject nativeStrings_;
    QProcess backend_;
    QByteArray output_;
    QHash<QString, Completion> pending_;
    QSet<QString> editorRequests_;
    DocsQtChannel* channel_ = nullptr;
    QWebEngineProfile* profile_ = nullptr;
    QWebEngineView* view_ = nullptr;
    QLabel* status_ = nullptr;
    ActionHandler actionHandler_;
    CreateWordHandler createWordHandler_;
    OpenFileHandler openFileHandler_;
    DocsQtPrinting* printing_ = nullptr;
    bool creationReported_ = false;
    bool ready_ = false;
    bool stopping_ = false;
    bool closeCheck_ = false;
    bool closeAllowed_ = false;
    std::function<void(bool)> closeDecision_;
    QTimer* closeTimer_ = nullptr;
    quint64 closeGeneration_ = 0;
};

} // namespace foraoffice
