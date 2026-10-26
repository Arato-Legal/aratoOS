import { afterEach, describe, expect, it } from "vitest";
import {
  GOOGLE_DRIVE_FULL_SCOPE,
  GOOGLE_DRIVE_SCOPE,
  driveScopeCanBrowse,
  googleDriveRequestedScope,
} from "../googleDrive";

const original = process.env.GOOGLE_DRIVE_SCOPE_MODE;
afterEach(() => {
  if (original === undefined) delete process.env.GOOGLE_DRIVE_SCOPE_MODE;
  else process.env.GOOGLE_DRIVE_SCOPE_MODE = original;
});

describe("matter folder browsing scope", () => {
  it("requests per-file access unless the deployment opts into full Drive", () => {
    delete process.env.GOOGLE_DRIVE_SCOPE_MODE;
    expect(googleDriveRequestedScope()).toBe(GOOGLE_DRIVE_SCOPE);
    process.env.GOOGLE_DRIVE_SCOPE_MODE = " Full ";
    expect(googleDriveRequestedScope()).toBe(GOOGLE_DRIVE_FULL_SCOPE);
    process.env.GOOGLE_DRIVE_SCOPE_MODE = "anything-else";
    expect(googleDriveRequestedScope()).toBe(GOOGLE_DRIVE_SCOPE);
  });

  it("lets only whole-Drive grants browse", () => {
    expect(driveScopeCanBrowse(`openid ${GOOGLE_DRIVE_FULL_SCOPE}`)).toBe(true);
    expect(driveScopeCanBrowse("https://www.googleapis.com/auth/drive.readonly")).toBe(true);
    expect(driveScopeCanBrowse(GOOGLE_DRIVE_SCOPE)).toBe(false);
    expect(driveScopeCanBrowse(null)).toBe(false);
  });
});
