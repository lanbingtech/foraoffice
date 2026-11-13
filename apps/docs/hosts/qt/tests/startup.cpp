#include "DocsQtEditor.hpp"
#include <QApplication>
#include <QCommandLineParser>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QJsonDocument>
#include <QTemporaryDir>
#include <QTextStream>
#include <QThread>
#include <QTimer>
#include <memory>

namespace {
bool writeFile(const QString& path, const QByteArray& bytes) {
    QFile file(path);
    return file.open(QIODevice::WriteOnly) && file.write(bytes) == bytes.size();
}
QString literal(const QString& value) {
    const auto json = QJsonDocument(QJsonArray{value}).toJson(QJsonDocument::Compact);
    return QString::fromUtf8(json.mid(1, json.size() - 2));
}
bool waitForFile(const QString& path, int timeout) {
    QElapsedTimer elapsed;
    elapsed.start();
    while (!QFile::exists(path) && elapsed.elapsed() < timeout) QThread::msleep(10);
    return QFile::exists(path);
}
}

int main(int argc, char** argv) {
    foraoffice::DocsQtEditor::registerUrlSchemes();
    QApplication app(argc, argv);
    QCommandLineParser parser;
    parser.addOptions({QCommandLineOption("package", "Built SDK directory", "directory"),
                       QCommandLineOption("node", "Node executable", "executable"),
                       QCommandLineOption("hold-exit", "Hold the child until view disposal returns")});
    parser.process(app);
    QTemporaryDir scratch;
    const auto root = scratch.path();
    const auto package = parser.value("package");
    if (!scratch.isValid() || !QDir().mkpath(root + "/qt") || !QDir().mkpath(root + "/services") ||
        !QDir().mkpath(root + "/documents") ||
        !QFile::copy(package + "/qt/native-strings.json", root + "/qt/native-strings.json")) return 2;
    const auto initialized = root + "/initialized";
    const auto exited = root + "/exited";
    const auto permitExit = root + "/permit-exit";
    // Observe the real backend reply in its own process while the GUI processes no events.
    const auto script = QStringLiteral(
        "const fs=require('node:fs');const write=process.stdout.write.bind(process.stdout);let buffered='';"
        "process.stdout.write=(chunk,...args)=>{buffered+=String(chunk);let end;"
        "while((end=buffered.indexOf('\\n'))>=0){const line=buffered.slice(0,end);buffered=buffered.slice(end+1);"
        "try{const m=JSON.parse(line);if(m.result?.assets&&m.result.nodeVersion)fs.writeFileSync(%1,'ready');}catch{}}"
        "return write(chunk,...args);};process.once('exit',()=>fs.writeFileSync(%2,'exited'));%4 require(%3);")
        .arg(literal(initialized), literal(exited), literal(package + "/services/node-host.cjs"),
            parser.isSet("hold-exit") ? QStringLiteral(
                "const hold=setInterval(()=>{if(fs.existsSync(%1))clearInterval(hold);},10);").arg(literal(permitExit)) : QString{});
    if (!writeFile(root + "/services/node-host.cjs", script.toUtf8())) return 2;
    foraoffice::DocsQtOptions options;
    options.packageRoot = root;
    options.nodeExecutable = parser.value("node");
    options.stateDirectory = root + "/state";
    options.readRoots = options.writeRoots = {root + "/documents"};
    options.defaultSaveDirectory = options.writeRoots.front();
    auto editor = std::make_unique<foraoffice::DocsQtEditor>(options);
    QElapsedTimer elapsed;
    elapsed.start();
    const bool readyWhileGuiPaused = waitForFile(initialized, 5000);
    QTextStream(stdout) << "backendInitializedWhileGuiPaused=" << readyWhileGuiPaused
                        << " observedMs=" << elapsed.elapsed() << Qt::endl;
    editor.reset();
    const bool disposalReturnedBeforeExit = !parser.isSet("hold-exit") || !QFile::exists(exited);
    if (parser.isSet("hold-exit") && !writeFile(permitExit, "exit")) return 2;
    const bool stoppedWithoutGui = !readyWhileGuiPaused || waitForFile(exited, 10000);
    QTextStream(stdout) << "backendExitedWithoutGui=" << stoppedWithoutGui << Qt::endl;
    // Drain ordinary GUI cleanup only after both independent-backend assertions.
    QTimer::singleShot(0, &app, &QCoreApplication::quit);
    app.exec();
    return readyWhileGuiPaused && disposalReturnedBeforeExit && stoppedWithoutGui ? 0 : 1;
}
