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
