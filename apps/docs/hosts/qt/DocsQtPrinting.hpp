#pragma once

#include <QByteArray>
#include <QList>
#include <QObject>
#include <QPageLayout>
#include <QPointer>
#include <QString>
#include <functional>
#include <optional>

class QWebEngineView;

namespace foraoffice {

struct DocsQtPrinter {
    QString name;
    QString displayName;
};

struct DocsQtPrintResult {
    bool ok = false;
    bool canceled = false;
    // A native job already handed to the driver may outlive cancellation or timeout.
    bool outcomeUnknown = false;
    QString error;
    QByteArray pdf;
};

struct DocsQtPrintOptions {
    enum class Duplex { Simplex, LongEdge, ShortEdge };
    // nullopt opens the native dialog; empty selects the OS default printer.
    std::optional<QString> deviceName;
    int copies = 1;
    bool collate = true;
    Duplex duplex = Duplex::Simplex;
    QPageLayout layout;
    double scale = 1.0;
};

class DocsQtPrintJob;

/** GUI-thread host primitives. Renderer owns print CSS and page selection;
 * caller owns sanitization, resource embedding, file authorization and PDF writes.
 * One job at a time, with no queued requests. Callbacks complete exactly once,
 * including disposal. Qt has no native print-scale option: only 1 is supported.
 */
class DocsQtPrinting final : public QObject {
public:
    using Completion = std::function<void(DocsQtPrintResult)>;
    explicit DocsQtPrinting(QWebEngineView* view, QObject* parent = nullptr);
    ~DocsQtPrinting() override;

    static QList<DocsQtPrinter> printers();
    static QPageLayout paperLayout(double widthTwips, double heightTwips);
    void renderHtml(const QString& sanitizedHtml, const QPageLayout& layout, Completion done);
    void printToPdf(const QPageLayout& layout, double scale, Completion done);
    void print(const DocsQtPrintOptions& options, Completion done);
    void cancel();

private:
    friend class DocsQtPrintJob;
    DocsQtPrintJob* begin(const QPageLayout& layout, double scale, Completion done);
    QPointer<QWebEngineView> view_;
    QPointer<DocsQtPrintJob> active_;
    bool disposed_ = false;
};

} // namespace foraoffice
