# Native Live Activity capture fixtures

The default iPhone listing and Kilter iPhone CPP use a reviewed physical-device
Live Activity card. CI reuses those pixels; it does not attempt to start or film
ActivityKit. Their nine framed screenshots still ship on the requested App Store
canvas (1206×2622 or 1320×2868). A card captured on an iPhone 13 Pro is never
described as a native iPhone 16 Pro screenshot.

Fixtures live in `app-stores/apple/live-activity-captures/`. `manifest.json`
records each crop's SHA-256, original full PNG SHA-256, measured crop rectangle,
physical device and native screen size, installed build, board/controller family,
capture surface, actual app and widget languages, and visual review. Full phone
screenshots, notifications, account credentials, and accessibility dumps remain
outside the repository.

Each fixture also records the original rectangular crop hash and an alpha-mask
hash. The measured extraction floods only edge-connected wallpaper pixels whose
red channel is at most 3 in these reviewed 1110×435 sRGB captures. A one-pixel
guard keeps mixed/antialiased native border pixels opaque. The card's RGB bytes,
including its border, title, thumbnail and controls, remain unchanged; only
exterior wallpaper becomes transparent. Unsupported dimensions, color profiles,
blank captures or incomplete contours stop extraction for local review.

The initial source is TestFlight **2.6.0 (18)** on a real iPhone 13 Pro,
1170×2532 native pixels / 390×844 points, using the Notification Centre Live
Activity and a real connected development controller presenting as Kilter.
The build's source commit is unknown; its provenance does not claim that it is
the recorder's current `main` commit. This proves native queue navigation outside
the app, not physical wall illumination. Native widget controls/counts can remain
English even when the app is in Spanish, French or German. Record the actual
`widgetLocale`; never translate the native pixels or duplicate an English
capture under another app locale.

## Regenerate locally

1. Install the supported Boardsesh TestFlight build on a connected iPhone. Use
   the authorized recording account; keep credentials and original screenshots
   in a private temporary directory. Select the intended app language and verify
   it in the app before each locale capture.
2. Select the actual Kilter board and start a private recording session. Add real
   climbs without clearing an existing queue. Connect the approved development
   controller. Previous/Next must appear on the genuine Live Activity; a
   disconnected card is not proof of outside-app navigation.
3. Open Notification Centre or the Lock Screen, allow Live Activities when
   prompted, and save a native **PNG**. Keep the phone awake while capturing.
   Select a clean frame showing the complete name, grade, thumbnail, queue
   position and controls. Confirm Next changes the actual climb/thumbnail/count
   without opening Boardsesh. Do not include permission dialogs or unrelated
   notifications in the crop.
4. Measure the full card in native pixels. A two-line climb name may increase
   its height, so do not reuse coordinates blindly. Review the crop and language
   evidence before supplying the provenance below. Then import it:

   ```bash
   vp exec tsx scripts/import-live-activity-capture.ts \
     --input /private/tmp/native-live-activity.png \
     --provenance /private/tmp/reviewed-live-activity.json
   ```

5. Regenerate the normal screenshot presentation with `vp run mobile:screenshots`
   or `vp exec tsx scripts/frame-screenshots.ts` using that run's raw captures.
   Review the contact sheet and `presentation.json` source provenance. End only
   the session created for this recording and restore the recording app language.

The importer performs a lossless rectangular crop followed by that measured
exterior-only alpha extraction. It calculates the hashes from the real input,
checks its dimensions and identity, and saves only the native card plus manifest
entry. It never draws a widget, fills missing
text, resizes the native fixture, or fabricates a translation. Use
`--output-root <private-directory>` to review a candidate before replacing the
committed fixture. A reviewer must verify the review statements; passing a JSON
schema cannot establish that a capture is genuine.

Example provenance for a reviewed English Kilter card (replace timestamps,
reviewer and measured bounds with the actual capture):

```json
{
  "boardFamily": "kilter",
  "appLocale": "en-US",
  "widgetLocale": "en",
  "captureSurface": "notification-center",
  "device": "iPhone13Pro",
  "sourceBuild": "TestFlight2.6.0(18)",
  "appSourceCommit": null,
  "capturedAt": "2026-10-14T06:30:00Z",
  "nativePixels": { "width": 1170, "height": 2532 },
  "screenPoints": { "width": 390, "height": 844 },
  "cropRect": { "x": 30, "y": 714, "width": 1110, "height": 435 },
  "content": {
    "climbName": "Orestes",
    "grade": "7b+/V8",
    "currentIndex": 261,
    "totalClimbs": 262,
    "nextEnabled": true
  },
  "controller": {
    "connection": "real-ble",
    "presentedBoardFamily": "kilter",
    "description": "Development controller presenting as Kilter",
    "physicalWallLightingVerified": false
  },
  "review": {
    "reviewedAt": "2026-10-14T06:35:00Z",
    "reviewedBy": "Actual reviewer",
    "nativePixelsUnmodified": true,
    "unrelatedNotificationsExcluded": true,
    "appLocaleVerified": true,
    "nextNavigationVerified": true
  }
}
```

## Capture and rendering gates

The default campaign no longer requires `17-dynamic-island.png`; the Kilter
phone CPP no longer requires `08-island.png`. Their Live Activity recipes load
the exact reviewed Kilter/app-locale fixture. A missing locale, another board
family, a changed hash, an invalid rectangle or unreviewed provenance stops
framing with an actionable error. The presented sidecar stores the native
fixture identity separately from its output canvas and hash.

If a retained default raw directory still contains `17-dynamic-island.png`,
move that obsolete capture outside the input directory before reframing. The
new source contract rejects it as an unexpected image. Likewise, a Kilter phone
raw directory must omit its old `08-island.png`.

Tension and MoonBoard retain their existing capture contracts until matched
native footage is reviewed. A Kilter development controller is not proof that
MoonBoard's different BLE protocol works. Spray walls have no native hardware
control capability and receive no Live Activity Next scene. Never substitute a
Kilter card under another family's source identity.

A genuine Tension card can use the approved Kilter-presenting Aurora development
controller after accepting the actual serial mismatch. Keep `boardFamily` as
`tension` and `controller.presentedBoardFamily` as `kilter`. This exception
requires reviewed native Next navigation and received LED payload evidence,
`physicalWallLightingVerified: false`, and explicit controller metadata:

```json
"compatibility": {
  "protocol": "aurora-uart",
  "targetBoardFamily": "tension",
  "serialMismatchAccepted": true,
  "verification": "native-next-and-received-led-payload"
}
```

This describes the controller used to capture Tension's actual native card; it
does not allow a Kilter card to stand in for Tension or MoonBoard pixels. Other
family mismatches and incomplete compatibility evidence remain rejected.

WDA screenshots can contain partial redraws even after an accessibility snapshot
has settled. Reject blank frames and missing title/count/control pixels. For
video, preserve timestamps and document any rejected captures and nearest clean
native-frame holds during conversion to 30 fps. Keep the observed Next action
and resulting native climb change; do not repair UI pixels or invent state.
