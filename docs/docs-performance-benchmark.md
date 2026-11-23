# Docs performance benchmark on Windows

## Input to correct desktop presentation

Use a Windows input driver independent of the editor thread. Verify the foreground
window and its process before sending input. Record the sequence and bracket each
submission with `QueryPerformanceCounter` timestamps so the measured interval
includes input queueing. Compare builds on the same display, refresh rate, scaling,
window size, document fixture and starting position. Record Chinese IME key to
preedit feedback and commit to displayed text and caret as separate intervals.

Define the expected text, insertion point and visible caret for each input.
In an instrumented editor, check the document position, DOM selection and visible
caret coordinates, then publish a revision marker with the corresponding view
update. Verify that the marker, text and caret reach the same desktop frame before
using the marker for acceptance. For other applications, use an independently
validated observation of the expected text and caret. The calibration below
establishes marker detection in a controlled window.

Use Windows Desktop Duplication `LastPresentTime` for the timestamp of the first
desktop update carrying the expected result. A probe can read a marker pixel and
retain its revision and time without storing screenshots. Record ambiguous frame
matches, missed frames and lost focus as capture failures. Record wrong text,
missing input and misplaced carets as behavioral failures. Report their counts
and causes alongside the latency distribution.

PresentMon helps diagnose swap-chain presentation mode, dropped frames and
display queueing. Windows Performance Recorder and renderer traces help locate
thread stalls and pagination work. Model publication, DOM visibility and animation
frame timestamps are useful intermediate milestones. Report them under their own
names. This benchmark ends at the Windows desktop update. Measuring the display
panel's optical response requires a separate setup.

## Comparisons and acceptance

Measure editing during progressive loading and after layout settles. Reproduce
the interactions that caused the reported stall, including typing at the affected
document positions. For scroll or navigation tests, verify the destination page,
text and position and whether editing can continue. Keep the sample counts and
acceptance thresholds specified for each scenario, host and version.
Check output and layout fidelity alongside the timing results.

Record P50, P95, the slowest sample, the longest continuous main-thread stall,
and the counts of valid, failed and missing observations. Identify the build, host,
fixture, cache state and exact timing boundaries. Retain source timestamps and
state evidence privately for reproduction. Use redistributable fixtures for
public CI. Apply the existing scenario-specific endpoints and thresholds to
loading, dragging, saving, printing and layout.

## Calibration evidence

On a 75 Hz display, an Electron 43.8.3 control window received nine Windows key
inputs. An unrelated region refreshed throughout the run. The control page
delayed the text, caret and marker update by 0, 100 or 250 ms.

- Desktop Duplication observed all nine expected marker changes. Each target
  frame had `AccumulatedFrames` equal to 1. The submission-to-marker times were
  approximately 28–58 ms, 116–146 ms and 271–286 ms for the three delay groups.
- Using the first PresentMon display event after the key reported an earlier
  result in all nine trials. Using the first event after `requestAnimationFrame`
  landed between the last old-marker desktop update and first new-marker update
  in three trials. The largest difference from the DXGI endpoint was 36 ms.
- PresentMon did not provide a valid `AllInputToPhotonLatency` value in this
  run. ForaOffice editor text and caret co-presentation and the equivalent WPS
  observation still require calibration before an end-to-end comparison.

[Microsoft Desktop Duplication frame timestamps](https://learn.microsoft.com/windows/win32/api/dxgi1_2/ns-dxgi1_2-dxgi_outdupl_frame_info) ·
[PresentMon 2.3.1 fields](https://github.com/GameTechDev/PresentMon/blob/v2.3.1/README-ConsoleApplication.md#comma-separated-value-csv-file-output)
