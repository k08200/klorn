// The delivery lifecycle of one notification on one channel (one
// PushDeliveryLog row): created → queued → sent → device_received → opened →
// actioned. The state is the furthest stage a timestamp proves — never one a
// later stage is guessed from.
import { describe, expect, it } from "vitest";
import {
  DELIVERY_STATES,
  deliveryState,
  desktopChannel,
  isReceiptAction,
} from "../notify/delivery-lifecycle.js";

const T = new Date("2026-11-12T00:00:00Z");
const EMPTY = {
  queuedAt: null,
  acceptedAt: null,
  receivedAt: null,
  clickedAt: null,
  actionedAt: null,
};

describe("deliveryState", () => {
  it("lists the six stages in order", () => {
    expect(DELIVERY_STATES).toEqual([
      "created",
      "queued",
      "sent",
      "device_received",
      "opened",
      "actioned",
    ]);
  });

  it("is created when nothing past the row itself was observed", () => {
    expect(deliveryState(EMPTY)).toBe("created");
  });

  it("is queued once the attempt was handed to its transport", () => {
    expect(deliveryState({ ...EMPTY, queuedAt: T })).toBe("queued");
  });

  it("is sent when the provider accepted, and never device_received from that alone", () => {
    expect(deliveryState({ ...EMPTY, queuedAt: T, acceptedAt: T })).toBe("sent");
  });

  it("is device_received only with a device receipt", () => {
    expect(deliveryState({ ...EMPTY, acceptedAt: T, receivedAt: T })).toBe("device_received");
  });

  it("is device_received for a desktop banner that was shown with no server send", () => {
    expect(deliveryState({ ...EMPTY, receivedAt: T })).toBe("device_received");
  });

  it("is opened after a click, and actioned after an action button", () => {
    expect(deliveryState({ ...EMPTY, receivedAt: T, clickedAt: T })).toBe("opened");
    expect(deliveryState({ ...EMPTY, receivedAt: T, clickedAt: T, actionedAt: T })).toBe(
      "actioned",
    );
  });
});

describe("desktopChannel", () => {
  it("names the channel of each desktop app", () => {
    expect(desktopChannel("mac")).toBe("desktop_mac");
    expect(desktopChannel("windows")).toBe("desktop_windows");
  });
});

describe("isReceiptAction", () => {
  it("accepts only the notification action buttons Klorn sends", () => {
    expect(isReceiptAction("reply")).toBe(true);
    expect(isReceiptAction("later")).toBe(true);
    expect(isReceiptAction("mute")).toBe(false);
    expect(isReceiptAction(undefined)).toBe(false);
  });
});
