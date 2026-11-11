import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATTACHMENT_MAX_BYTES, attachmentDisplayName, attachmentPath, checkAttachment, isImageAttachment,
} from "../../src/lib/attachments.ts";
import { formatBytes } from "../../src/lib/format.ts";

test("checkAttachment accepts listed types within 25 MB and maps the extension", () => {
  assert.deepEqual(checkAttachment("application/pdf", 1), { ok: true, ext: "pdf" });
  assert.deepEqual(checkAttachment("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ATTACHMENT_MAX_BYTES), { ok: true, ext: "xlsx" });
});

test("checkAttachment refuses executable/markup types, empty and oversized files", () => {
  for (const type of ["text/html", "image/svg+xml", "application/x-msdownload", "application/javascript", ""]) {
    assert.deepEqual(checkAttachment(type, 10), { ok: false, error: "attachment.unsupported_type" }, type);
  }
  assert.deepEqual(checkAttachment("application/pdf", 0), { ok: false, error: "attachment.too_large" });
  assert.deepEqual(checkAttachment("application/pdf", ATTACHMENT_MAX_BYTES + 1), { ok: false, error: "attachment.too_large" });
  assert.deepEqual(checkAttachment("application/pdf", 1.5), { ok: false, error: "attachment.too_large" });
});

test("attachmentPath keeps the original name out of the storage key", () => {
  assert.equal(attachmentPath("c", "lead", "e", "a".repeat(24), "pdf"), `c/lead/e/${"a".repeat(24)}.pdf`);
});

test("attachmentDisplayName keeps Arabic, strips separators and control characters", () => {
  assert.equal(attachmentDisplayName("عرض سعر.pdf"), "عرض سعر.pdf");
  assert.equal(attachmentDisplayName("../../etc/passwd"), ".._.._etc_passwd");
  assert.equal(attachmentDisplayName("a\u0000b\nc.txt"), "a_b_c.txt");
  assert.equal(attachmentDisplayName("   "), "file");
  assert.equal(attachmentDisplayName("x".repeat(300) + ".pdf").length, 255);
  assert.ok(attachmentDisplayName("x".repeat(300) + ".pdf").endsWith(".pdf"), "the extension survives truncation");
});

test("only raster images open inline", () => {
  assert.ok(isImageAttachment("image/png"));
  assert.ok(!isImageAttachment("application/pdf"));
  assert.ok(!isImageAttachment("image/svg+xml"));
});

test("formatBytes uses 1024-based units with Latin digits", () => {
  assert.equal(formatBytes(512, "en"), "512 B");
  assert.equal(formatBytes(1536, "en"), "1.5 KB");
  assert.equal(formatBytes(25 * 1024 * 1024, "en"), "25 MB");
  assert.equal(formatBytes(2048, "ar"), "2 ك.ب");
  assert.equal(formatBytes(null, "en"), "—");
});
