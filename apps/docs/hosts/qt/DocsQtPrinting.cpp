#include "DocsQtPrinting.hpp"

#include <QCoreApplication>
#include <QDialog>
#include <QDir>
#include <QPrintDialog>
#include <QPrinter>
#include <QPrinterInfo>
#include <QTemporaryFile>
#include <QTimer>
#include <QUrl>
#include <QWebEnginePage>
#include <QWebEngineProfile>
#include <QWebEngineSettings>
#include <QWebEngineUrlRequestInfo>
#include <QWebEngineUrlRequestInterceptor>
#include <QWebEngineView>
#include <atomic>
#include <cmath>
#include <memory>
#include <utility>

namespace foraoffice {
namespace {

DocsQtPrintResult failure(const QString& error)
{
    DocsQtPrintResult result;
    result.error = error;
    return result;
}

// The render input must carry its own resources. Never give generated HTML the
// live editor profile, its custom schemes, cookies, network or local-file access.
class PrintResources final : public QWebEngineUrlRequestInterceptor {
public:
    PrintResources(QUrl document, QObject* parent)
        : QWebEngineUrlRequestInterceptor(parent), document_(std::move(document)) {}
    void interceptRequest(QWebEngineUrlRequestInfo& request) override
    {
        const bool allowed = request.requestUrl().scheme() == QStringLiteral("data")
            || (request.resourceType() == QWebEngineUrlRequestInfo::ResourceTypeMainFrame
                && request.requestUrl() == document_);
        if (!allowed) {
            blocked.store(true);
            request.block(true);
        }
    }
    std::atomic_bool blocked = false;
private:
    const QUrl document_;
};

} // namespace

// A native printer must survive the editor/host until Qt's asynchronous spool
// work finishes. Jobs therefore belong to the application, not the editor.
class DocsQtPrintJob final : public QObject {
    friend class DocsQtPrinting;
public:
    DocsQtPrintJob(DocsQtPrinting* owner, DocsQtPrinting::Completion done)
        : QObject(QCoreApplication::instance()), done_(std::move(done)), owner_(owner)
    {
        timer_.setSingleShot(true);
        connect(&timer_, &QTimer::timeout, this, [this] {
            auto result = failure(QStringLiteral("Printing timed out"));
            result.outcomeUnknown = submitted_;
            complete(std::move(result));
            if (page_) page_->triggerAction(QWebEnginePage::Stop);
        });
    }
    ~DocsQtPrintJob() override
    {
        // Qt can invoke pending PDF callbacks while deleting the page.
        destroying_ = true;
        done_ = {};
        delete page_;
        delete profile_;
    }
    bool completed() const { return !done_; }
    void cancel()
    {
        DocsQtPrintResult result;
        result.canceled = !submitted_;
        result.outcomeUnknown = submitted_;
        if (submitted_) result.error = QStringLiteral("Native print outcome is unknown after cancellation");
        complete(std::move(result));
        if (page_) page_->triggerAction(QWebEnginePage::Stop);
    }
    void watch(QWebEngineView* view)
    {
        view_ = view;
        connect(view, &QObject::destroyed, this, [this] {
            view_ = nullptr;
            auto result = failure(QStringLiteral("Print view disposed"));
            result.outcomeUnknown = submitted_;
            complete(std::move(result));
            if (submitted_) retirePrinter();
        });
        connect(view, &QWebEngineView::loadStarted, this, [this] {
            auto result = failure(QStringLiteral("Print view navigated during printing"));
            result.outcomeUnknown = submitted_;
            complete(std::move(result));
        });
        connect(view, &QWebEngineView::renderProcessTerminated, this, [this] {
            auto result = failure(QStringLiteral("Print renderer terminated"));
            result.outcomeUnknown = submitted_;
            complete(std::move(result));
        });
    }
    void pdf(QWebEnginePage* page, const QPageLayout& layout)
    {
        pdfPending_ = true;
        timer_.start(60000);
        QPointer<DocsQtPrintJob> guard(this);
        page->printToPdf([guard](const QByteArray& bytes) {
            // Do not touch the page/view: Qt also calls this during destruction.
            if (!guard || guard->destroying_) return;
            guard->pdfPending_ = false;
            auto result = bytes.isEmpty() ? failure(QStringLiteral("PDF rendering failed"))
                                          : DocsQtPrintResult{};
            result.ok = !bytes.isEmpty();
            result.pdf = bytes;
            guard->complete(std::move(result));
        }, layout);
    }
    void html(const QString& html, const QPageLayout& layout)
    {
        source_ = std::make_unique<QTemporaryFile>(QDir::tempPath()
            + QStringLiteral("/foraoffice-print-XXXXXX.html"));
        const auto bytes = html.toUtf8();
        if (!source_->open() || source_->write(bytes) != bytes.size() || !source_->flush()) {
            complete(failure(QStringLiteral("Cannot prepare HTML print source")));
            return;
        }
        source_->close();
        const auto url = QUrl::fromLocalFile(source_->fileName());
        profile_ = new QWebEngineProfile(this);
        auto resources = new PrintResources(url, profile_);
        profile_->setUrlRequestInterceptor(resources);
        page_ = new QWebEnginePage(profile_, this);
        page_->settings()->setAttribute(QWebEngineSettings::JavascriptEnabled, false);
        page_->settings()->setAttribute(QWebEngineSettings::LocalContentCanAccessFileUrls, false);
        page_->settings()->setAttribute(QWebEngineSettings::LocalContentCanAccessRemoteUrls, false);
        page_->settings()->setAttribute(QWebEngineSettings::PrintElementBackgrounds, true);
        connect(page_, &QWebEnginePage::loadFinished, this, [this, layout, resources](bool ok) {
            if (completed()) return;
            if (!ok || resources->blocked.load()) {
                complete(failure(QStringLiteral("HTML print source failed to load or contains external resources")));
                return;
            }
            pdf(page_, layout);
        });
        connect(page_, &QWebEnginePage::renderProcessTerminated, this, [this] {
            complete(failure(QStringLiteral("HTML print renderer terminated")));
        });
        timer_.start(60000);
        // setHtml() has Chromium's 2 MB data-URL limit; a private temporary file
        // supports embedded images and fonts without that artificial limit.
        page_->load(url);
    }
    void native(const DocsQtPrintOptions& options)
    {
        QPrinterInfo info = options.deviceName && !options.deviceName->isEmpty()
            ? QPrinterInfo::printerInfo(*options.deviceName) : QPrinterInfo::defaultPrinter();
        if (options.deviceName && info.isNull()) {
            complete(failure(QStringLiteral("Requested printer is unavailable")));
            return;
        }
        printer_ = std::make_unique<QPrinter>(info, QPrinter::HighResolution);
        printer_->setOutputFormat(QPrinter::NativeFormat);
        printer_->setResolution(qMax(300, printer_->resolution()));
        printer_->setCopyCount(options.copies);
        printer_->setCollateCopies(options.collate);
        const auto duplex = options.duplex == DocsQtPrintOptions::Duplex::LongEdge
            ? QPrinter::DuplexLongSide : options.duplex == DocsQtPrintOptions::Duplex::ShortEdge
            ? QPrinter::DuplexShortSide : QPrinter::DuplexNone;
        const auto supported = info.supportedDuplexModes();
        if (options.deviceName && !supported.isEmpty() && !supported.contains(duplex)) {
            complete(failure(QStringLiteral("Requested duplex mode is unsupported by this printer")));
            return;
        }
        printer_->setDuplex(duplex);
        if (!printer_->setPageLayout(options.layout)) {
            complete(failure(QStringLiteral("Printer cannot use the requested paper layout")));
            return;
        }
        printer_->setFullPage(true);
        if (options.deviceName) {
            submit();
            return;
        }
        dialog_ = new QPrintDialog(printer_.get(), view_);
        connect(dialog_, &QDialog::finished, this, [this](int result) {
            if (completed()) return;
            dialog_->deleteLater();
            dialog_ = nullptr;
            if (result != QDialog::Accepted) {
                cancel();
                return;
            }
            submit();
        });
        dialog_->open();
    }
private:
    void submit()
    {
        if (!view_ || !printer_->isValid()) {
            complete(failure(QStringLiteral("Print view or printer is unavailable")));
            return;
        }
        connect(view_, &QWebEngineView::printFinished, this, [this](bool ok) {
            submitted_ = false;
            auto result = ok ? DocsQtPrintResult{} : failure(QStringLiteral("Native printing failed"));
            result.ok = ok;
            complete(std::move(result));
        });
        submitted_ = true;
        timer_.start(120000);
        view_->print(printer_.get());
    }
    void complete(DocsQtPrintResult result)
    {
        if (!submitted_ && !pdfPending_) {
            // Release the operation slot before calling client code. Deferred
            // QObject deletion must not make a completed job appear busy.
            if (owner_ && owner_->active_ == this) owner_->active_.clear();
            if (view_) disconnect(view_, nullptr, this, nullptr);
            deleteLater();
        }
        if (!done_) return;
        timer_.stop();
        if (dialog_) {
            disconnect(dialog_, nullptr, this, nullptr);
            dialog_->close();
            dialog_->deleteLater();
            dialog_ = nullptr;
        }
        if (auto done = std::exchange(done_, {})) done(std::move(result));
    }
    void retirePrinter()
    {
        // Qt documents that a destroyed view can leave the native spool worker
        // running. Keep its QPrinter alive until its state is no longer Active.
        auto drain = new QTimer(this);
        connect(drain, &QTimer::timeout, this, [this] {
            if (printer_->printerState() != QPrinter::Active) {
                submitted_ = false;
                complete({});
            }
        });
        drain->start(25);
    }
    DocsQtPrinting::Completion done_;
    QPointer<DocsQtPrinting> owner_;
    QTimer timer_;
    QPointer<QWebEngineView> view_;
    QPointer<QPrintDialog> dialog_;
    std::unique_ptr<QPrinter> printer_;
    std::unique_ptr<QTemporaryFile> source_;
    QWebEngineProfile* profile_ = nullptr;
    QWebEnginePage* page_ = nullptr;
    bool submitted_ = false;
    bool pdfPending_ = false;
    bool destroying_ = false;
};

DocsQtPrinting::DocsQtPrinting(QWebEngineView* view, QObject* parent)
    : QObject(parent), view_(view) {}

DocsQtPrinting::~DocsQtPrinting()
{
    disposed_ = true;
    cancel();
}

QList<DocsQtPrinter> DocsQtPrinting::printers()
{
    QList<DocsQtPrinter> result;
    for (const auto& info : QPrinterInfo::availablePrinters())
        result.append({info.printerName(), info.printerName()});
    return result;
}

QPageLayout DocsQtPrinting::paperLayout(double widthTwips, double heightTwips)
{
    if (!std::isfinite(widthTwips) || !std::isfinite(heightTwips)
        || widthTwips < 144 || widthTwips > 72000 || heightTwips < 144 || heightTwips > 72000)
        return {};
    return QPageLayout(QPageSize(QSizeF(widthTwips / 20.0, heightTwips / 20.0),
                       QPageSize::Point, {}, QPageSize::ExactMatch),
                       QPageLayout::Portrait, QMarginsF(), QPageLayout::Point);
}

DocsQtPrintJob* DocsQtPrinting::begin(const QPageLayout& layout, double scale, Completion done)
{
    QString error;
    if (disposed_) error = QStringLiteral("Printing host disposed");
    else if (active_) error = QStringLiteral("Another print job is active");
    else if (!layout.isValid()) error = QStringLiteral("Invalid print layout");
    else if (!std::isfinite(scale) || scale != 1.0)
        error = QStringLiteral("Qt printing supports only scale 1");
    if (!error.isEmpty()) {
        if (done) done(failure(error));
        return nullptr;
    }
    if (!done) return nullptr;
    active_ = new DocsQtPrintJob(this, std::move(done));
    return active_;
}

void DocsQtPrinting::renderHtml(const QString& html, const QPageLayout& layout, Completion done)
{
    if (auto job = begin(layout, 1, std::move(done))) job->html(html, layout);
}

void DocsQtPrinting::printToPdf(const QPageLayout& layout, double scale, Completion done)
{
    if (auto job = begin(layout, scale, std::move(done))) {
        if (!view_) {
            job->complete(failure(QStringLiteral("Print view is unavailable")));
            return;
        }
        job->watch(view_);
        job->pdf(view_->page(), layout);
    }
}

void DocsQtPrinting::print(const DocsQtPrintOptions& options, Completion done)
{
    if (options.copies < 1 || options.copies > 999) {
        if (done) done(failure(QStringLiteral("Print copies must be between 1 and 999")));
        return;
    }
    if (auto job = begin(options.layout, options.scale, std::move(done))) {
        if (!view_) {
            job->complete(failure(QStringLiteral("Print view is unavailable")));
            return;
        }
        job->watch(view_);
        job->native(options);
    }
}

void DocsQtPrinting::cancel()
{
    if (active_) active_->cancel();
}

} // namespace foraoffice
