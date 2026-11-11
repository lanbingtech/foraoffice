#include "DocsQtEditor.hpp"
#include <QApplication>
#include <QDir>
#include <QEventLoop>
#include <QFile>
#include <QJsonDocument>
#include <QPointer>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QTimer>
#include <QWebEnginePage>
#include <QWebEngineView>
#include <QtTest>
#include <memory>

namespace {
QJsonObject call(foraoffice::DocsQtEditor& editor, const QString& operation, const QJsonObject& arguments = {}) {
    QEventLoop loop;
    auto reply = std::make_shared<QJsonObject>();
    editor.callSdk(operation, arguments, [reply, guard = QPointer<QEventLoop>(&loop)](const QJsonObject& result) {
        *reply = result; if (guard) guard->quit();
    });
    if (reply->isEmpty()) { QTimer::singleShot(35000, &loop, &QEventLoop::quit); loop.exec(); }
    return *reply;
}
QJsonObject script(foraoffice::DocsQtEditor& editor, const QString& expression) {
    editor.view()->page()->runJavaScript(QStringLiteral(
        "window.__sdkTest=null;(async()=>{try{window.__sdkTest={ok:true,result:await (%1)};}"
        "catch(e){window.__sdkTest={ok:false,error:String(e)};}})();").arg(expression));
    auto result = std::make_shared<QJsonObject>();
    QElapsedTimer timeout; timeout.start();
    while (result->isEmpty() && timeout.elapsed() < 30000) {
        QEventLoop loop;
        editor.view()->page()->runJavaScript("window.__sdkTest", [result, guard = QPointer<QEventLoop>(&loop)](const QVariant& value) {
            *result = QJsonObject::fromVariantMap(value.toMap()); if (guard) guard->quit();
        });
        QTimer::singleShot(1000, &loop, &QEventLoop::quit); loop.exec();
        if (result->isEmpty()) QTest::qWait(20);
    }
    return *result;
}
QByteArray pdf(foraoffice::DocsQtEditor& editor) {
    QEventLoop loop;
    auto bytes = std::make_shared<QByteArray>();
    editor.view()->page()->printToPdf([bytes, guard = QPointer<QEventLoop>(&loop)](const QByteArray& result) {
        *bytes = result; if (guard) guard->quit();
    });
    QTimer::singleShot(30000, &loop, &QEventLoop::quit); loop.exec();
    return *bytes;
}
void write(const QString& path, const QByteArray& bytes) {
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly) || file.write(bytes) != bytes.size()) qFatal("Cannot write SDK test output");
}
QString literal(const QString& value) {
    const auto json = QJsonDocument(QJsonArray{value}).toJson(QJsonDocument::Compact);
    return QString::fromUtf8(json.mid(1, json.size() - 2));
}
}

class SdkTests final : public QObject {
    Q_OBJECT
private slots:
    void ribbonContributionsUseThePublicSdkAndNativeActionSignal() {
        QTemporaryDir workspace;
        foraoffice::DocsQtOptions options;
        options.packageRoot = qEnvironmentVariable("FORAOFFICE_QT_TEST_PACKAGE");
        options.nodeExecutable = qEnvironmentVariable("FORAOFFICE_QT_TEST_NODE");
        options.stateDirectory = workspace.filePath(".state");
        options.defaultSaveDirectory = workspace.path();
        options.readRoots = options.writeRoots = {workspace.path()};
        options.language = "en";
        options.documentHost = {{"enabled", true}, {"autoSave", QJsonObject{{"enabled", false}}}};
        foraoffice::DocsQtEditor editor(options);
        editor.resize(1100, 850);
        for (const auto& method : {QStringLiteral("initialDocument"), QStringLiteral("openDocument")})
            editor.setServiceHandler(method, [](const QJsonArray&, foraoffice::DocsQtEditor::Completion done) {
                done({{"result", QJsonObject{{"id", "host:ribbon"}, {"name", "Document.docx"}}}});
            });
        editor.setServiceHandler("confirmDocumentReplace", [](const QJsonArray&, foraoffice::DocsQtEditor::Completion done) { done({{"result", true}}); });
        editor.setServiceHandler("recentDocuments", [](const QJsonArray&, foraoffice::DocsQtEditor::Completion done) { done({{"result", QJsonArray{}}}); });
        QSignalSpy ready(&editor, &foraoffice::DocsQtEditor::ready);
        QSignalSpy actions(&editor, &foraoffice::DocsQtEditor::ribbonActionTriggered);
        editor.show();
        QTRY_COMPARE_WITH_TIMEOUT(ready.size(), 1, 30000);
        const auto before = call(editor, "snapshot").value("result");
        const auto state = call(editor, "documents.state").value("result").toObject();
        const auto token = state.value("documentToken");
        const auto button = [](const QString& id, const QString& label) {
            return QJsonObject{{"type", "button"}, {"id", id}, {"label", label}, {"actionId", "extension." + id}};
        };
        const QJsonObject configuration{
            {"documentToken", token},
            {"tabs", QJsonArray{QJsonObject{{"id", "extension.tools"}, {"label", "Extension tools"}, {"groups", QJsonArray{
                QJsonObject{{"id", "tools"}, {"label", "Tools"}, {"items", QJsonArray{button("inspect", "Inspect")}}}}}}}},
            {"groups", QJsonArray{QJsonObject{{"tabId", "home"}, {"id", "home-tools"}, {"label", "Home tools"}, {"items", QJsonArray{
                QJsonObject{{"type", "menu"}, {"id", "more"}, {"label", "More tools"}, {"items", QJsonArray{
                    QJsonObject{{"type", "action"}, {"id", "run"}, {"label", "Run action"}, {"actionId", "extension.run"}}}}}}}}}},
            {"quickAccess", QJsonArray{button("quick", "Quick action")}}
        };
        QVERIFY(!call(editor, "ui.ribbon.set", configuration).contains("error"));
        const auto click = [&](const QString& label) {
            return script(editor, QStringLiteral("(async()=>{await new Promise(requestAnimationFrame);const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===%1||b.textContent.trim()===%1);if(!b)throw Error('Missing control');b.click();await new Promise(requestAnimationFrame);return true})()").arg(literal(label)));
        };
        QVERIFY(click("Quick action").value("ok").toBool());
        QVERIFY(click("Extension tools").value("ok").toBool());
        QVERIFY(click("Inspect").value("ok").toBool());
        QVERIFY(click("Home").value("ok").toBool());
        QVERIFY(click("More tools").value("ok").toBool());
        QVERIFY(click("Run action").value("ok").toBool());
        QTRY_COMPARE_WITH_TIMEOUT(actions.size(), 3, 10000);
        QCOMPARE(actions.at(0)[0].toString(), QStringLiteral("extension.quick"));
        QCOMPARE(actions.at(1)[1].toJsonObject().value("tabId").toString(), QStringLiteral("extension.tools"));
        QCOMPARE(actions.at(2)[1].toJsonObject().value("documentToken"), token);
        QCOMPARE(call(editor, "snapshot").value("result"), before);
        QCOMPARE(call(editor, "documents.state").value("result").toObject(), state);
        QVERIFY(call(editor, "documents.open").value("result").toBool());
        QVERIFY(call(editor, "ui.ribbon.set", configuration).contains("error"));
        QVERIFY(script(editor, "(()=>!document.querySelector('[data-ribbon-tab]')&&![...document.querySelectorAll('.qa-btn')].some(b=>b.getAttribute('aria-label')==='Quick action'))()").value("result").toBool());
        QVERIFY(!call(editor, "ui.ribbon.reset").contains("error"));
        QVERIFY(script(editor, "(()=>{window.docsEditor.dispose();return true})()").value("ok").toBool());
        QVERIFY(call(editor, "ui.ribbon.reset").contains("error"));
        editor.close();
    }
    void fileMenuUsesPublicSdkAndExistingManagedServices() {
        QTemporaryDir workspace;
        foraoffice::DocsQtOptions options;
        options.packageRoot = qEnvironmentVariable("FORAOFFICE_QT_TEST_PACKAGE");
        options.nodeExecutable = qEnvironmentVariable("FORAOFFICE_QT_TEST_NODE");
        options.stateDirectory = workspace.filePath(".state");
        options.defaultSaveDirectory = workspace.path();
        options.readRoots = options.writeRoots = {workspace.path()};
        options.language = "en";
        options.documentHost = {{"enabled", true}, {"autoSave", QJsonObject{{"enabled", false}}}};
        foraoffice::DocsQtEditor editor(options);
        editor.resize(1100, 850);
        for (const auto& method : {QStringLiteral("initialDocument"), QStringLiteral("newDocument"), QStringLiteral("openDocument")})
            editor.setServiceHandler(method, [](const QJsonArray&, foraoffice::DocsQtEditor::Completion done) {
                done({{"result", QJsonObject{{"id", "host:menu"}, {"name", "Menu.docx"}}}});
            });
        editor.setServiceHandler("confirmDocumentReplace", [](const QJsonArray&, foraoffice::DocsQtEditor::Completion done) { done({{"result", true}}); });
        editor.setServiceHandler("recentDocuments", [](const QJsonArray&, foraoffice::DocsQtEditor::Completion done) { done({{"result", QJsonArray{}}}); });
        int saves = 0, exports = 0;
        QString lastKind;
        QByteArray saved;
        editor.setServiceHandler("saveDocument", [&](const QJsonArray& args, foraoffice::DocsQtEditor::Completion done) {
            const auto request = args.at(0).toObject();
            saved = QByteArray::fromBase64(request.value("data").toObject().value("base64").toString().toLatin1());
            saves++; lastKind = request.value("kind").toString();
            done({{"result", QJsonObject{{"ok", true}, {"committed", true}, {"pending", false}, {"adopt", false}}}});
        });
        editor.setServiceHandler("exportHtml", [&](const QJsonArray& args, foraoffice::DocsQtEditor::Completion done) {
            QVERIFY(args.at(1).toString().contains("Menu content"));
            exports++;
            done({{"result", QJsonObject{{"ok", true}, {"path", "host:export"}}}});
        });
        QSignalSpy ready(&editor, &foraoffice::DocsQtEditor::ready);
        QSignalSpy failed(&editor, &foraoffice::DocsQtEditor::failed);
        QSignalSpy states(&editor, &foraoffice::DocsQtEditor::documentStateChanged);
        QSignalSpy actions(&editor, &foraoffice::DocsQtEditor::menuActionTriggered);
        editor.show();
        QTRY_VERIFY_WITH_TIMEOUT(!ready.isEmpty() || !failed.isEmpty(), 90000);
        QVERIFY2(!ready.isEmpty(), failed.isEmpty() ? "Editor did not become ready" : qPrintable(failed.front()[0].toString()));
        QTRY_VERIFY_WITH_TIMEOUT(!states.isEmpty(), 10000);
        QVERIFY(script(editor, "(async()=>{const c=window.docsEditor.runtime.connect({id:'menu'});c.context();try{return await c.execute({id:'edit',name:'insert_content',input:{html:'<p>Menu content</p>'}})}finally{c.close()}})()").value("ok").toBool());
        const auto before = call(editor, "snapshot").value("result");
        const auto state = call(editor, "documents.state").value("result").toObject();
        const auto token = state.value("documentToken");
        QJsonArray items{
            QJsonObject{{"type", "group"}, {"id", "storage"}, {"items", QJsonArray{
                QJsonObject{{"type", "command"}, {"id", "save"}, {"command", "save"}, {"label", "Menu Save"}},
                QJsonObject{{"type", "command"}, {"id", "save-as"}, {"command", "saveAs"}, {"label", "Menu Copy"}}}}},
            QJsonObject{{"type", "submenu"}, {"id", "export"}, {"label", "Export"}, {"items", QJsonArray{
                QJsonObject{{"type", "command"}, {"id", "html"}, {"command", "exportHtml"}, {"label", "HTML"}}}}},
            QJsonObject{{"type", "action"}, {"id", "publish"}, {"actionId", "business.publish"}, {"label", "Publish"}},
            QJsonObject{{"type", "action"}, {"id", "hidden"}, {"actionId", "hidden"}, {"label", "Hidden"}, {"visible", false}}
        };
        QVERIFY(!call(editor, "ui.fileMenu.set", {{"documentToken", token}, {"items", items}}).contains("error"));
        QCOMPARE(call(editor, "snapshot").value("result"), before);
        QCOMPARE(call(editor, "documents.state").value("result").toObject(), state);
        const auto click = [&](const QString& label) {
            return script(editor, QStringLiteral("(async()=>{if(!document.querySelector('.file-menu'))document.querySelector('.ribbon-tab-file').click();await new Promise(requestAnimationFrame);const b=[...document.querySelectorAll('.file-menu button')].find(b=>b.textContent.trim().startsWith(%1));if(!b)throw Error('Missing menu item');b.click();await new Promise(requestAnimationFrame);return true})()").arg(literal(label)));
        };
        QVERIFY(click("Publish").value("ok").toBool());
        QTRY_COMPARE_WITH_TIMEOUT(actions.size(), 1, 10000);
        QCOMPARE(actions.front()[0].toString(), QStringLiteral("business.publish"));
        QCOMPARE(actions.front()[1].toJsonObject().value("documentToken"), token);
        QCOMPARE(saves, 0);
        auto updated = items.at(2).toObject(); updated.insert("label", "Published"); updated.insert("enabled", false); items[2] = updated;
        QVERIFY(!call(editor, "ui.fileMenu.set", {{"documentToken", token}, {"items", items}}).contains("error"));
        QVERIFY(click("Published").value("ok").toBool());
        QCOMPARE(actions.size(), 1);
        QCOMPARE(call(editor, "snapshot").value("result"), before);
        QCOMPARE(call(editor, "documents.state").value("result").toObject(), state);
        QVERIFY(click("Menu Save").value("ok").toBool());
        QTRY_COMPARE_WITH_TIMEOUT(saves, 1, 15000);
        QCOMPARE(lastKind, QStringLiteral("save"));
        QVERIFY(saved.startsWith("PK"));
        QTRY_VERIFY_WITH_TIMEOUT(!call(editor, "documents.state").value("result").toObject().value("dirty").toBool(), 10000);
        QVERIFY(click("Menu Copy").value("ok").toBool());
        QTRY_COMPARE_WITH_TIMEOUT(saves, 2, 15000);
        QCOMPARE(lastKind, QStringLiteral("saveAs"));
        QVERIFY(click("Export").value("ok").toBool());
        QVERIFY(click("HTML").value("ok").toBool());
        QTRY_COMPARE_WITH_TIMEOUT(exports, 1, 10000);
        QCOMPARE(call(editor, "documents.state").value("result").toObject().value("documentToken"), token);
        QVERIFY(call(editor, "documents.open").value("result").toBool());
        const auto reopened = call(editor, "documents.state").value("result").toObject();
        QCOMPARE(reopened.value("id"), state.value("id"));
        QVERIFY(reopened.value("documentToken") != token);
        QVERIFY(call(editor, "ui.fileMenu.set", {{"documentToken", token}, {"items", items}}).contains("error"));
        QVERIFY(!call(editor, "ui.fileMenu.reset").contains("error"));
        QVERIFY(script(editor, "(()=>{window.docsEditor.dispose();return true})()").value("ok").toBool());
        QVERIFY(call(editor, "ui.fileMenu.reset").contains("error"));
        editor.close();
    }
    void publicSdkWorksInARealManagedQtEditor() {
        QTemporaryDir workspace;
        QTemporaryDir outside;
        const auto picture = outside.filePath("picture.png");
        write(picture, QByteArray::fromBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="));
        foraoffice::DocsQtOptions options;
        options.packageRoot = qEnvironmentVariable("FORAOFFICE_QT_TEST_PACKAGE");
        options.nodeExecutable = qEnvironmentVariable("FORAOFFICE_QT_TEST_NODE");
        options.stateDirectory = workspace.filePath(".state");
        options.defaultSaveDirectory = workspace.path();
        options.readRoots = options.writeRoots = {workspace.path()};
        options.language = "en";
        options.documentHost = {{"enabled", true}, {"autoSave", QJsonObject{{"enabled", false}}}};
        options.documentCheckers = {"fixture"};
        foraoffice::DocsQtEditor editor(options);
        editor.resize(1100, 850);
        QByteArray saved;
        bool cancelNew = false;
        bool readOnly = false;
        bool adoptCopy = false;
        bool missingCopyDecision = false;
        int saves = 0;
        const auto document = [&] {
            QJsonObject result{{"id", readOnly ? "host:readonly" : "host:document"}, {"name", "Hosted.docx"}, {"readOnly", readOnly}};
            if (!saved.isEmpty()) result.insert("data", QJsonObject{{"base64", QString::fromLatin1(saved.toBase64())}});
            return result;
        };
        for (const auto& method : {QStringLiteral("initialDocument"), QStringLiteral("openDocument"), QStringLiteral("newDocument")}) {
            editor.setServiceHandler(method, [&, method](const QJsonArray&, foraoffice::DocsQtEditor::Completion done) {
                done({{"result", method == "newDocument" && cancelNew ? QJsonValue(QJsonValue::Null) : QJsonValue(document())}});
            });
        }
        editor.setServiceHandler("recentDocuments", [](const QJsonArray&, foraoffice::DocsQtEditor::Completion done) { done({{"result", QJsonArray{}}}); });
        editor.setServiceHandler("confirmDocumentReplace", [](const QJsonArray&, foraoffice::DocsQtEditor::Completion done) { done({{"result", true}}); });
        editor.setServiceHandler("saveDocument", [&](const QJsonArray& args, foraoffice::DocsQtEditor::Completion done) {
            const auto request = args.at(0).toObject();
            saved = QByteArray::fromBase64(request.value("data").toObject().value("base64").toString().toLatin1());
            saves++;
            auto identity = document(); identity.remove("data");
            if (request.value("kind") == "saveAs" && adoptCopy) identity.insert("id", "host:copy");
            QJsonObject outcome{{"ok", true}, {"committed", true}, {"pending", false},
                {"document", identity}, {"adopt", request.value("kind") != "saveAs" || adoptCopy}};
            if (missingCopyDecision) outcome.remove("adopt");
            done({{"result", outcome}});
        });
        editor.setServiceHandler("checkDocument", [](const QJsonArray& args, foraoffice::DocsQtEditor::Completion done) {
            const auto snapshot = args.at(1).toObject();
            const auto text = snapshot.value("text").toString();
            const auto positions = snapshot.value("positions").toArray();
            const auto at = text.indexOf('[');
            QJsonArray findings;
            if (at >= 0 && !text.mid(at).contains(']')) findings.append(QJsonObject{
                {"from", positions.at(at)}, {"to", positions.at(text.size() - 1).toInt() + 1}, {"message", "Unclosed fixture expression"}});
            done({{"result", findings}});
        });
        QSignalSpy ready(&editor, &foraoffice::DocsQtEditor::ready);
        QSignalSpy failed(&editor, &foraoffice::DocsQtEditor::failed);
        editor.show();
        QTRY_VERIFY_WITH_TIMEOUT(!ready.isEmpty() || !failed.isEmpty(), 90000);
        QVERIFY2(!ready.isEmpty(), failed.isEmpty() ? "Editor did not become ready" : qPrintable(failed.front()[0].toString()));
        QCOMPARE(call(editor, "documents.state").value("result").toObject().value("id").toString(), QStringLiteral("host:document"));
        const auto edit = script(editor, "(async()=>{const c=window.docsEditor.runtime.connect({id:'fixture'});c.context();"
            "try{return await c.execute({id:'insert',name:'insert_content',input:{html:'<p>same <b>sa</b>me same [invalid</p>'}})}finally{c.close()}})()");
        QVERIFY2(edit.value("ok").toBool(), qPrintable(QString::fromUtf8(QJsonDocument(edit).toJson())));
        QVERIFY(!edit.value("result").toObject().value("isError").toBool());
        const auto found = call(editor, "find", {{"query", "same"}}).value("result").toObject();
        const auto matches = found.value("matches").toArray();
        QCOMPARE(matches.size(), 3);
        for (const auto& match : matches) QVERIFY(!call(editor, "locate", {{"reference", match}}).contains("error"));
        QVERIFY(!call(editor, "annotations.setRules", {{"source", "display"}, {"rules", QJsonArray{QJsonObject{
            {"id", "highlight"}, {"pattern", "same"}, {"style", QJsonObject{{"background", "yellow"}, {"underline", true}}}}}}}).contains("error"));
        const auto diagnostics = call(editor, "annotations.refresh").value("result").toArray();
        QCOMPARE(diagnostics.size(), 1);
        const auto output = qEnvironmentVariable("FORAOFFICE_QT_TEST_RESULTS");
        QVERIFY(QDir().mkpath(output));
        const auto decorated = pdf(editor);
        QVERIFY(decorated.startsWith("%PDF"));
        write(output + "/annotated.pdf", decorated);
        call(editor, "annotations.remove", {{"source", "display"}});
        call(editor, "annotations.remove", {{"source", "fixture"}});
        write(output + "/clean.pdf", pdf(editor));
        call(editor, "annotations.setRules", {{"source", "advisory"}, {"rules", QJsonArray{QJsonObject{
            {"id", "invalid"}, {"pattern", "invalid"}, {"message", "Advisory fixture diagnostic"}}}}});
        QCOMPARE(call(editor, "replace", {{"result", found}, {"replacement", "word"}}).value("result").toObject().value("count").toInt(), 3);
        QVERIFY(call(editor, "locate", {{"reference", matches.at(0)}}).contains("error"));
        const auto imageExpression = QStringLiteral("(async()=>{const c=window.docsEditor.runtime.connect({id:'image'});c.context();try{return await c.execute({id:'image',name:'insert_picture',input:{source:{path:%1}}})}finally{c.close()}})()").arg(literal(picture));
        QVERIFY(script(editor, imageExpression).value("result").toObject().value("isError").toBool());
        QJsonObject grant;
        editor.grantFile(picture, true, false, [&](const QJsonObject& result) { grant = result; });
        QTRY_VERIFY_WITH_TIMEOUT(!grant.isEmpty(), 10000);
        QVERIFY(!grant.contains("error"));
        const auto inserted = script(editor, imageExpression);
        QVERIFY(inserted.value("ok").toBool());
        QVERIFY2(!inserted.value("result").toObject().value("isError").toBool(), qPrintable(QString::fromUtf8(QJsonDocument(inserted).toJson())));
        QVERIFY(call(editor, "documents.save").value("result").toBool());
        QCOMPARE(saves, 1);
        QVERIFY(saved.startsWith("PK"));
        write(output + "/hosted.docx", saved);
        missingCopyDecision = true;
        QVERIFY(!call(editor, "documents.save", {{"saveAs", true}}).value("result").toBool());
        QCOMPARE(call(editor, "documents.state").value("result").toObject().value("id").toString(), QStringLiteral("host:document"));
        missingCopyDecision = false;
        QVERIFY(call(editor, "documents.save", {{"saveAs", true}}).value("result").toBool());
        QCOMPARE(call(editor, "documents.state").value("result").toObject().value("id").toString(), QStringLiteral("host:document"));
        adoptCopy = true;
        const auto beforeCopy = call(editor, "find", {{"query", "word"}}).value("result").toObject().value("matches").toArray().at(0);
        QVERIFY(call(editor, "documents.save", {{"saveAs", true}}).value("result").toBool());
        QCOMPARE(call(editor, "documents.state").value("result").toObject().value("id").toString(), QStringLiteral("host:copy"));
        QVERIFY(call(editor, "locate", {{"reference", beforeCopy}}).contains("error"));
        cancelNew = true;
        QVERIFY(!call(editor, "documents.new").value("result").toBool());
        QCOMPARE(call(editor, "documents.state").value("result").toObject().value("id").toString(), QStringLiteral("host:copy"));
        cancelNew = false; readOnly = true;
        QVERIFY(call(editor, "documents.new").value("result").toBool());
        QVERIFY(call(editor, "documents.state").value("result").toObject().value("readOnly").toBool());
        const auto next = call(editor, "find", {{"query", "word"}}).value("result").toObject();
        QCOMPARE(next.value("matches").toArray().size(), 3);
        QVERIFY(call(editor, "replace", {{"result", next}, {"replacement", "refused"}}).contains("error"));
        QVERIFY(!call(editor, "annotations.setRules", {{"source", "readonly"}, {"rules", QJsonArray{QJsonObject{
            {"id", "read"}, {"pattern", "word"}, {"style", QJsonObject{{"underline", true}}}}}}}).contains("error"));
        QVERIFY(!call(editor, "locate", {{"reference", next.value("matches").toArray().at(1)}}).contains("error"));
        QVERIFY(script(editor, "document.querySelectorAll('.sdk-range-decoration').length").value("result").toInt() > 0);
        QVERIFY(!call(editor, "documents.save").value("result").toBool());
        QVERIFY(!call(editor, "documents.state").value("result").toObject().value("dirty").toBool());
        QJsonObject revoke;
        editor.revokeFile(picture, [&](const QJsonObject& result) { revoke = result; });
        QTRY_VERIFY_WITH_TIMEOUT(!revoke.isEmpty(), 10000);
        bool checkerWaiting = false;
        editor.setServiceHandler("checkDocument", [&](const QJsonArray&, foraoffice::DocsQtEditor::Completion) {
            checkerWaiting = true; // Deliberately leave a public refresh outstanding while closing.
        });
        QJsonObject canceled;
        editor.callSdk("annotations.refresh", {}, [&](const QJsonObject& result) { canceled = result; });
        QTRY_VERIFY_WITH_TIMEOUT(checkerWaiting, 10000);
        editor.close();
        QTRY_VERIFY_WITH_TIMEOUT(!canceled.isEmpty(), 10000);
        QVERIFY(canceled.contains("error"));
        // Closing the QWidget leaves owned process cleanup independent of the GUI loop.
    }
};

int main(int argc, char** argv) {
    foraoffice::DocsQtEditor::registerUrlSchemes();
    QApplication app(argc, argv);
    SdkTests tests;
    const auto result = QTest::qExec(&tests, argc, argv);
    QTimer::singleShot(0, &app, &QCoreApplication::quit); app.exec();
    return result;
}
#include "sdk.moc"
