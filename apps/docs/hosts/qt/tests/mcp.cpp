#include "DocsQtEditor.hpp"
#include <QApplication>
#include <QDir>
#include <QEventLoop>
#include <QJsonDocument>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QPointer>
#include <QProcess>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QTimer>
#include <QWebEnginePage>
#include <QWebEngineView>
#include <QtTest>
#include <memory>

namespace {
using Editor = foraoffice::DocsQtEditor;
QJsonObject native(const std::function<void(Editor::Completion)>& operation) {
    QEventLoop loop;
    auto result = std::make_shared<QJsonObject>();
    operation([result, guard = QPointer<QEventLoop>(&loop)](const QJsonObject& reply) {
        *result = reply; if (guard) guard->quit();
    });
    if (result->isEmpty()) { QTimer::singleShot(35000, &loop, &QEventLoop::quit); loop.exec(); }
    return *result;
}
QJsonObject sdk(Editor& editor, const QString& operation) {
    return native([&](Editor::Completion done) { editor.callSdk(operation, {}, std::move(done)); });
}
QJsonObject start(Editor& editor) {
    return native([&](Editor::Completion done) { editor.startMcp(std::move(done)); });
}
QJsonObject state(Editor& editor) {
    return native([&](Editor::Completion done) { editor.mcpState(std::move(done)); }).value("result").toObject();
}
struct HttpReply { int status; QJsonObject body; QByteArray session; };
HttpReply rpc(const QJsonObject& connection, const QString& method, const QJsonObject& params = {}, const QByteArray& session = {}) {
    QNetworkAccessManager network;
    QNetworkRequest request(QUrl(connection.value("url").toString()));
    request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    request.setRawHeader("Accept", "application/json, text/event-stream");
    request.setRawHeader("MCP-Protocol-Version", "2025-11-25");
    request.setRawHeader("Authorization", connection.value("headers").toObject().value("Authorization").toString().toUtf8());
    if (!session.isEmpty()) request.setRawHeader("Mcp-Session-Id", session);
    const QJsonObject message{{"jsonrpc", "2.0"}, {"id", "test"}, {"method", method}, {"params", params}};
    auto* reply = network.post(request, QJsonDocument(message).toJson(QJsonDocument::Compact));
    QEventLoop loop;
    QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    QTimer::singleShot(10000, reply, &QNetworkReply::abort);
    loop.exec();
    const auto bytes = reply->readAll();
    auto body = QJsonDocument::fromJson(bytes).object();
    for (const auto& line : bytes.split('\n'))
        if (line.startsWith("data: ")) body = QJsonDocument::fromJson(line.mid(6)).object();
    return {reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), body, reply->rawHeader("Mcp-Session-Id")};
}
QByteArray initialize(const QJsonObject& connection) {
    const auto reply = rpc(connection, "initialize", {{"protocolVersion", "2025-11-25"},
        {"capabilities", QJsonObject{}}, {"clientInfo", QJsonObject{{"name", "native-sdk-test"}, {"version", "1"}}}});
    return reply.status == 200 && reply.body.contains("result") ? reply.session : QByteArray{};
}
}

class McpTests final : public QObject {
    Q_OBJECT
private slots:
    void hostControlsLiveDocumentAccessWithoutAnActionHandler() {
        QTemporaryDir workspace;
        foraoffice::DocsQtOptions options;
        options.packageRoot = qEnvironmentVariable("FORAOFFICE_QT_TEST_PACKAGE");
        options.nodeExecutable = qEnvironmentVariable("FORAOFFICE_QT_TEST_NODE");
        options.stateDirectory = workspace.filePath(".state");
        options.defaultSaveDirectory = workspace.path();
        options.readRoots = options.writeRoots = {workspace.path()};
        options.language = "en";
        options.documentHost = {{"enabled", true}, {"autoSave", QJsonObject{{"enabled", false}}}};
        auto editor = std::make_unique<Editor>(options);
        bool cancelNew = false;
        bool readOnly = false;
        editor->setServiceHandler("initialDocument", [](const QJsonArray&, Editor::Completion done) { done({{"result", QJsonValue::Null}}); });
        editor->setServiceHandler("recentDocuments", [](const QJsonArray&, Editor::Completion done) { done({{"result", QJsonArray{}}}); });
        editor->setServiceHandler("newDocument", [&](const QJsonArray&, Editor::Completion done) {
            done({{"result", cancelNew ? QJsonValue(QJsonValue::Null) : QJsonValue(QJsonObject{{"id", "host:document"}, {"name", "Document"}, {"readOnly", readOnly}})}});
        });
        editor->setServiceHandler("confirmDocumentReplace", [](const QJsonArray&, Editor::Completion done) { done({{"result", true}}); });
        QSignalSpy ready(editor.get(), &Editor::ready);
        QSignalSpy failed(editor.get(), &Editor::failed);
        QSignalSpy changed(editor.get(), &Editor::mcpStateChanged);
        QVERIFY(start(*editor).contains("error"));
        editor->resize(1000, 800); editor->show();
        QTRY_VERIFY_WITH_TIMEOUT(!ready.isEmpty() || !failed.isEmpty(), 90000);
        QVERIFY2(!ready.isEmpty(), failed.isEmpty() ? "Editor did not become ready" : qPrintable(failed.front()[0].toString()));
        QVERIFY(start(*editor).contains("error")); // A ready managed mount can have no active document.
        QVERIFY(sdk(*editor, "documents.new").value("result").toBool());
        const auto enabled = start(*editor);
        QVERIFY2(!enabled.contains("error"), qPrintable(QString::fromUtf8(QJsonDocument(enabled).toJson())));
        const auto connection = enabled.value("result").toObject().value("connection").toObject();
        QVERIFY(connection.value("url").toString().endsWith("/mcp"));
        QCOMPARE(connection.value("transport").toString(), QStringLiteral("streamable-http"));
        QCOMPARE(start(*editor).value("result"), enabled.value("result"));
        QCOMPARE(state(*editor).value("status").toString(), QStringLiteral("running"));
        // Exercise the packaged example with the official client as well as raw HTTP.
        QProcess client;
        client.start(options.nodeExecutable, {QDir(options.packageRoot).filePath("examples/mcp-http-client.mjs")});
        client.write(QJsonDocument(connection).toJson(QJsonDocument::Compact));
        client.closeWriteChannel();
        QEventLoop clientLoop;
        connect(&client, &QProcess::finished, &clientLoop, &QEventLoop::quit);
        QTimer::singleShot(30000, &client, &QProcess::kill);
        clientLoop.exec();
        QCOMPARE(client.exitStatus(), QProcess::NormalExit);
        QVERIFY2(client.exitCode() == 0, client.readAllStandardError().constData());
        const auto clientResult = QJsonDocument::fromJson(client.readAllStandardOutput()).object();
        QVERIFY(clientResult.value("tools").toArray().contains("read_document"));
        const auto session = initialize(connection);
        QVERIFY(!session.isEmpty());
        const auto write = rpc(connection, "tools/call", {{"name", "insert_content"}, {"arguments", QJsonObject{{"html", "<p>Unsaved Agent edit</p>"}}}}, session);
        QVERIFY2(!write.body.value("result").toObject().value("isError").toBool(), qPrintable(QString::fromUtf8(QJsonDocument(write.body).toJson())));
        QVERIFY(sdk(*editor, "snapshot").value("result").toObject().value("text").toString().contains("Unsaved Agent edit"));
        QVERIFY(sdk(*editor, "documents.state").value("result").toObject().value("dirty").toBool());
        const auto read = rpc(connection, "tools/call", {{"name", "read_document"}}, session);
        QVERIFY(QJsonDocument(read.body).toJson().contains("Unsaved Agent edit"));
        // Embedded images must be readable through the public MCP transport, not only displayed.
        const QString png = QStringLiteral("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=");
        const auto picture = rpc(connection, "tools/call", {{"name", "insert_picture"}, {"arguments", QJsonObject{{"url", "data:image/png;base64," + png}, {"afterBlockIndex", 0}}}}, session);
        QVERIFY2(!picture.body.value("result").toObject().value("isError").toBool(), qPrintable(QString::fromUtf8(QJsonDocument(picture.body).toJson())));
        rpc(connection, "tools/call", {{"name", "get_document_context"}}, session);
        const auto media = rpc(connection, "tools/call", {{"name", "read_document_media"}, {"arguments", QJsonObject{{"blockIndex", 1}}}}, session);
        const auto mediaResult = media.body.value("result").toObject();
        QVERIFY2(!mediaResult.value("isError").toBool(), qPrintable(QString::fromUtf8(QJsonDocument(media.body).toJson())));
        bool imageReturned = false;
        for (const auto& item : mediaResult.value("content").toArray()) {
            const auto content = item.toObject();
            if (content.value("type") == "image") {
                QCOMPARE(content.value("mimeType").toString(), QStringLiteral("image/png"));
                QCOMPARE(content.value("data").toString(), png);
                imageReturned = true;
            }
        }
        QVERIFY(imageReturned);
        cancelNew = true;
        QVERIFY(!sdk(*editor, "documents.new").value("result").toBool());
        QCOMPARE(state(*editor).value("status").toString(), QStringLiteral("running"));
        cancelNew = false;
        QVERIFY(sdk(*editor, "documents.new").value("result").toBool());
        QTRY_COMPARE_WITH_TIMEOUT(state(*editor).value("status").toString(), QStringLiteral("stopped"), 10000);
        QVERIFY(rpc(connection, "tools/call", {{"name", "read_document"}}, session).status != 200);

        // No client has initialized this second grant when the document is replaced.
        const auto unused = start(*editor).value("result").toObject().value("connection").toObject();
        readOnly = true;
        QVERIFY(sdk(*editor, "documents.new").value("result").toBool());
        QTRY_COMPARE_WITH_TIMEOUT(state(*editor).value("status").toString(), QStringLiteral("stopped"), 10000);
        QVERIFY(initialize(unused).isEmpty());
        const auto readonlyConnection = start(*editor).value("result").toObject().value("connection").toObject();
        const auto readonlySession = initialize(readonlyConnection);
        QVERIFY(!readonlySession.isEmpty());
        const auto refused = rpc(readonlyConnection, "tools/call", {{"name", "insert_content"}, {"arguments", QJsonObject{{"html", "<p>Refused</p>"}}}}, readonlySession);
        QVERIFY(refused.body.value("result").toObject().value("isError").toBool());
        QVERIFY(!native([&](Editor::Completion done) { editor->stopMcp(std::move(done)); }).contains("error"));
        QVERIFY(!native([&](Editor::Completion done) { editor->stopMcp(std::move(done)); }).contains("error"));
        QCOMPARE(state(*editor).value("status").toString(), QStringLiteral("stopped"));

        auto starting = std::make_shared<QJsonObject>();
        editor->startMcp([starting](const QJsonObject& reply) { *starting = reply; });
        QVERIFY(!native([&](Editor::Completion done) { editor->stopMcp(std::move(done)); }).contains("error"));
        QTRY_VERIFY_WITH_TIMEOUT(!starting->isEmpty(), 10000);
        QVERIFY(starting->contains("error"));
        QCOMPARE(state(*editor).value("status").toString(), QStringLiteral("stopped"));
        const auto reenabled = start(*editor);
        QVERIFY2(!reenabled.contains("error"), qPrintable(QString::fromUtf8(QJsonDocument(reenabled).toJson())));
        const auto disposed = reenabled.value("result").toObject().value("connection").toObject();
        QVERIFY(!initialize(disposed).isEmpty());
        QVERIFY(!changed.isEmpty());
        editor.reset();
        QTRY_VERIFY_WITH_TIMEOUT(initialize(disposed).isEmpty(), 10000);
    }
};

int main(int argc, char** argv) {
    Editor::registerUrlSchemes();
    QApplication app(argc, argv);
    McpTests tests;
    const auto result = QTest::qExec(&tests, argc, argv);
    QTimer::singleShot(0, &app, &QCoreApplication::quit); app.exec();
    return result;
}
#include "mcp.moc"
