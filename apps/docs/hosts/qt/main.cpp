#include "DocsQtEditor.hpp"
#include <QApplication>
#include <QCommandLineParser>
#include <QDir>
#include <QJsonDocument>
#include <QMenuBar>
#include <QMenu>
#include <QAction>
#include <QLayout>
#include <QStandardPaths>
#include <QTextStream>
#include <QPointer>
#include <QTimer>
#include <memory>
#include <utility>

namespace {
void configureEditor(foraoffice::DocsQtEditor& editor, const foraoffice::DocsQtOptions& options, bool harnessStdio) {
    editor.setWindowTitle(QStringLiteral("ForaOffice Docs"));
    editor.resize(1280, 900);
    auto* menuBar = new QMenuBar(&editor);
    auto* fileMenu = menuBar->addMenu(editor.nativeText("menuFile"));
    const auto addCommand = [&editor, fileMenu](const QString& label, QKeySequence::StandardKey shortcut, const QString& command) {
        auto* action = fileMenu->addAction(label);
        action->setShortcut(QKeySequence(shortcut));
        action->setEnabled(false);
        QObject::connect(&editor, &foraoffice::DocsQtEditor::ready, action, [action] { action->setEnabled(true); });
        QObject::connect(action, &QAction::triggered, &editor, [&editor, command] { editor.triggerMenuCommand(command); });
    };
    addCommand(editor.nativeText("menuNewDoc"), QKeySequence::New, "new");
    addCommand(editor.nativeText("menuOpen"), QKeySequence::Open, "open");
    addCommand(editor.nativeText("menuSave"), QKeySequence::Save, "save");
    addCommand(editor.nativeText("menuSaveAs"), QKeySequence::SaveAs, "save-as");
    fileMenu->addSeparator();
    QObject::connect(fileMenu->addAction(editor.nativeText("menuClose")), &QAction::triggered, &editor, &QWidget::close);
    editor.layout()->setMenuBar(menuBar);
    if (harnessStdio) editor.setActionHandler([](const QJsonObject& action, const QJsonObject& grant, foraoffice::DocsQtEditor::Completion done) {
        QTextStream(stdout) << QJsonDocument(QJsonObject{{"event", "actionReady"}, {"action", action}, {"grant", grant}})
            .toJson(QJsonDocument::Compact) << Qt::endl;
        done({{"ok", true}});
    });
    editor.setCreateWordHandler([options, harnessStdio](const QJsonObject& content, foraoffice::DocsQtEditor::Completion done) {
        auto next = options;
        next.initialPath.clear();
        next.initialContent = {{"title", content.value("title")}, {"html", content.value("html")},
            {"targetPath", content.value("path")}, {"creationId", content.value("creationId")}};
        auto* child = new foraoffice::DocsQtEditor(next);
        child->setAttribute(Qt::WA_DeleteOnClose);
        configureEditor(*child, next, harnessStdio);
        const auto completion = std::make_shared<foraoffice::DocsQtEditor::Completion>(std::move(done));
        const auto finish = [completion](const QJsonObject& outcome) {
            auto callback = std::exchange(*completion, {});
            if (callback) callback(outcome);
        };
        QObject::connect(child, &foraoffice::DocsQtEditor::documentCreated, child, finish);
        QObject::connect(child, &foraoffice::DocsQtEditor::failed, child, [finish](const QString& error) {
            finish({{"ok", false}, {"committed", QJsonValue::Null}, {"pending", true}, {"error", error}, {"errorCode", "host_failure"}});
        });
        QObject::connect(child, &QObject::destroyed, qApp, [finish] {
            finish({{"ok", false}, {"committed", QJsonValue::Null}, {"pending", true}, {"error", "The created Word view closed before acknowledging its save"}, {"errorCode", "canceled"}});
        });
        QTimer::singleShot(120000, child, [finish] {
            finish({{"ok", false}, {"committed", QJsonValue::Null}, {"pending", true}, {"error", "The first Word save acknowledgement timed out"}, {"errorCode", "host_failure"}});
        });
        child->show();
    });
    QObject::connect(&editor, &foraoffice::DocsQtEditor::failed, qApp, [](const QString& message) {
        QTextStream(stderr) << message << Qt::endl;
    });
}
}

int main(int argc, char** argv) {
    foraoffice::DocsQtEditor::registerUrlSchemes();
    QApplication app(argc, argv);
    QCoreApplication::setApplicationName(QStringLiteral("ForaOffice Docs Qt"));
    QCommandLineParser parser;
    parser.addHelpOption();
    parser.addOptions({
        QCommandLineOption("package", "Compiled Docs package directory.", "directory"),
        QCommandLineOption("node", "Independent Node executable.", "executable", QStandardPaths::findExecutable("node")),
        QCommandLineOption("workspace", "Authorized document directory.", "directory"),
        QCommandLineOption("state", "Private host state directory.", "directory"),
        QCommandLineOption("open", "Initial authorized Word document.", "file"),
        QCommandLineOption("language", "Editor UI language.", "language", "zh"),
        QCommandLineOption("attachment", "A resource file under the authorized workspace (repeatable).", "file"),
        QCommandLineOption("knowledge", "A knowledge source under the authorized workspace (repeatable).", "file"),
        QCommandLineOption("harness-stdio", "Send action grants to the owning Harness controller over stdout."),
    });
    parser.process(app);
    if (parser.value("package").isEmpty() || parser.value("workspace").isEmpty() || parser.value("state").isEmpty())
        parser.showHelp(2);
    foraoffice::DocsQtOptions options;
    options.packageRoot = QDir(parser.value("package")).absolutePath();
    options.nodeExecutable = parser.value("node");
    options.stateDirectory = QDir(parser.value("state")).absolutePath();
    options.readRoots = options.writeRoots = {QDir(parser.value("workspace")).absolutePath()};
    options.defaultSaveDirectory = options.writeRoots.front();
    options.initialPath = parser.value("open");
    options.language = parser.value("language");
    options.attachments = parser.values("attachment");
    options.knowledge = parser.values("knowledge");
    foraoffice::DocsQtEditor editor(options);
    configureEditor(editor, options, parser.isSet("harness-stdio"));
    editor.show();
    return app.exec();
}
