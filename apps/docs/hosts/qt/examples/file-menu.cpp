#include "DocsQtEditor.hpp"
#include <QApplication>
#include <QCommandLineParser>
#include <QDebug>
#include <QDir>
#include <QStandardPaths>
#include <memory>

namespace {
QJsonObject command(const QString& id, const QString& name) {
    return {{"type", "command"}, {"id", id}, {"command", name}};
}
QJsonObject action(const QString& id, const QString& label, bool enabled) {
    return {{"type", "action"}, {"id", id}, {"actionId", "host." + id},
        {"label", label}, {"enabled", enabled}};
}

// The host may call this again after its permissions or workflow state changes.
void updateMenu(foraoffice::DocsQtEditor& editor, const QJsonValue& state) {
    const auto document = state.toObject();
    const bool hasDocument = !document.isEmpty();
    const bool writable = hasDocument && !document.value("readOnly").toBool();
    const QJsonArray items{
        QJsonObject{{"type", "group"}, {"id", "documents"}, {"items", QJsonArray{
            command("new", "new"), command("open", "open"),
            command("save", "save"), command("save-as", "saveAs")}}},
        QJsonObject{{"type", "group"}, {"id", "workflow"}, {"items", QJsonArray{
            action("rename", "Rename…", writable), action("publish", "Publish…", writable),
            action("history", "Version history…", hasDocument)}}},
        QJsonObject{{"type", "submenu"}, {"id", "export"}, {"label", "Export"}, {"items", QJsonArray{
            command("pdf", "exportPdf"), command("html", "exportHtml"),
            command("markdown", "exportMarkdown"), command("images", "exportImages")}}},
        QJsonObject{{"type", "group"}, {"id", "window"}, {"items", QJsonArray{
            action("close", "Close", true)}}}
    };
    editor.callSdk("ui.fileMenu.set", {
        {"documentToken", hasDocument ? document.value("documentToken") : QJsonValue(QJsonValue::Null)},
        {"items", items},
    }, [](const QJsonObject& reply) {
        if (reply.contains("error")) qWarning() << "Menu configuration rejected:" << reply.value("error");
    });
}
}

int main(int argc, char** argv) {
    foraoffice::DocsQtEditor::registerUrlSchemes();
    QApplication app(argc, argv);
    QCommandLineParser parser;
    parser.addHelpOption();
    parser.addOptions({
        QCommandLineOption("package", "Built Docs SDK directory.", "directory"),
        QCommandLineOption("workspace", "Authorized document directory.", "directory"),
        QCommandLineOption("state", "Private host state directory.", "directory"),
        QCommandLineOption("node", "Node executable.", "executable", QStandardPaths::findExecutable("node")),
    });
    parser.process(app);
    if (parser.value("package").isEmpty() || parser.value("workspace").isEmpty() || parser.value("state").isEmpty()) parser.showHelp(2);
    foraoffice::DocsQtOptions options;
    options.packageRoot = parser.value("package");
    options.nodeExecutable = parser.value("node");
    options.stateDirectory = parser.value("state");
    options.readRoots = options.writeRoots = {QDir(parser.value("workspace")).absolutePath()};
    options.defaultSaveDirectory = options.writeRoots.front();
    options.language = "en";
    foraoffice::DocsQtEditor editor(options);
    // Subscribe once for the widget lifetime. Each action carries the document
    // snapshot and session token, so asynchronous host work can keep its target.
    QObject::connect(&editor, &foraoffice::DocsQtEditor::menuActionTriggered, &editor,
        [&editor](const QString& id, const QJsonObject& context) {
            if (id == "host.close") { editor.close(); return; } // Runs the existing unsaved-change check.
            // Replace this example observer with the host's business operations.
            // The editor intentionally implements no rename/publish/history workflow.
            qInfo() << "Host action:" << id << "document:" << context.value("document");
        });
    auto previous = std::make_shared<QJsonObject>();
    QObject::connect(&editor, &foraoffice::DocsQtEditor::documentStateChanged, &editor,
        [&editor, previous](const QJsonValue& state) {
            auto relevant = state.toObject();
            relevant.remove("dirty"); // A content edit alone does not change this example's menu.
            if (*previous == relevant && !previous->isEmpty()) return;
            *previous = relevant;
            updateMenu(editor, state);
        });
    QObject::connect(&editor, &foraoffice::DocsQtEditor::failed, &editor,
        [](const QString& message) { qWarning() << message; });
    // Managed storage uses the same menu: configure options.documentHost and
    // setServiceHandler("saveDocument", ...) before the editor becomes ready.
    editor.resize(1280, 900);
    editor.show();
    return app.exec();
}
