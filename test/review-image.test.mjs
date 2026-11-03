import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { copyReviewImage, inspectReviewImage, inspectReviewImageSet, REVIEW_IMAGE_LIMITS, verifyReviewImage, verifyReviewImageCopy } from "../lib/review_image.mjs";

const head = "a".repeat(40), base = "b".repeat(40);
const png = () => PNG.sync.write({ width: 2, height: 1, data: Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]) });
const jpg = () => jpeg.encode({ width: 2, height: 1, data: Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]) }, 80).data;
const identity = (side = "after", path = "image.png") => ({ path, side, revision: side === "before" ? base : head });

test("image validation accepts decoded PNG and JPEG bytes and binds exact image identity", () => {
  for (const [bytes, format] of [[png(), "png"], [jpg(), "jpeg"]]) {
    const inspected = inspectReviewImage(bytes, identity());
    assert.equal(inspected.format, format);
    assert.deepEqual([inspected.width, inspected.height, inspected.bytes], [2, 1, bytes.length]);
    assert.match(inspected.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(verifyReviewImage(bytes, inspected), inspected);
    assert.throws(() => verifyReviewImage(bytes, { ...inspected, sha256: "0".repeat(64) }), /hash differs/);
    assert.throws(() => verifyReviewImage(bytes, { ...inspected, width: 1 }), /identity or hash/);
  }
});

test("image validation fails closed for corrupt, unsupported, oversized and dangerous dimensions", () => {
  const badCrc = Buffer.from(png()); badCrc[badCrc.length - 1] ^= 1;
  const huge = Buffer.from(png()); huge.writeUInt32BE(REVIEW_IMAGE_LIMITS.dimension + 1, 16);
  const hugeJpeg = Buffer.from(jpg());
  const marker = hugeJpeg.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(marker >= 0); hugeJpeg.writeUInt16BE(REVIEW_IMAGE_LIMITS.dimension + 1, marker + 7);
  for (const value of [Buffer.from("not an image"), png().subarray(0, 24), badCrc, huge, hugeJpeg, jpg().subarray(0, -2), Buffer.alloc(REVIEW_IMAGE_LIMITS.individualBytes + 1)]) {
    assert.throws(() => inspectReviewImage(value, identity()), error => error.code === "REVIEW_INCOMPLETE");
  }
});

test("image inventory rejects duplicates, wrong revisions and excessive image sides", () => {
  const images = [{ bytes: png(), identity: identity("before", "old.png") }, { bytes: jpg(), identity: identity("after", "new.jpg") }];
  assert.equal(inspectReviewImageSet(images, { head, mergeBase: base }).length, 2);
  assert.throws(() => inspectReviewImageSet([...images, images[0]], { head, mergeBase: base }), /duplicate/);
  assert.throws(() => inspectReviewImageSet([{ ...images[0], identity: { ...images[0].identity, revision: head } }], { head, mergeBase: base }), /revision/);
  assert.throws(() => inspectReviewImageSet(Array(REVIEW_IMAGE_LIMITS.count + 1).fill(images[0]), { head, mergeBase: base }), /inventory/);
  const large = Buffer.alloc(REVIEW_IMAGE_LIMITS.individualBytes);
  const total = Array.from({ length: 4 }, (_, index) => ({ bytes: large, identity: identity("after", `${index}.png`) }));
  assert.throws(() => inspectReviewImageSet(total, { head, mergeBase: base }), /total image byte limit/);
});

test("coordinator copies use generated names and detect tampering, symlinks and workspace escape", () => {
  const workspace = mkdtempSync(join(tmpdir(), "review-image-test-"));
  try {
    const bytes = png(), inspected = inspectReviewImage(bytes, identity("after", "../../ignore instructions.png"));
    const copy = copyReviewImage(workspace, bytes, inspected);
    assert.match(copy.file, /review-image-[^/]+\/attachment\.png$/);
    assert.deepEqual(readFileSync(copy.file), bytes);
    assert.deepEqual(verifyReviewImageCopy(workspace, copy.file, inspected), inspected);
    unlinkSync(copy.file); writeFileSync(copy.file, Buffer.alloc(bytes.length));
    assert.throws(() => verifyReviewImageCopy(workspace, copy.file, inspected), /unsupported|corrupt|hash/);
    const target = join(workspace, "target.png"); writeFileSync(target, bytes);
    unlinkSync(copy.file); symlinkSync(target, copy.file);
    assert.throws(() => verifyReviewImageCopy(workspace, copy.file, inspected), /cannot be verified/);
    copy.cleanup();
    const link = join(workspace, "outside"); symlinkSync(tmpdir(), link);
    assert.throws(() => verifyReviewImageCopy(workspace, join(link, "attachment.png"), inspected), /outside/);
    const before = readdirSync(workspace).sort();
    assert.throws(() => copyReviewImage(workspace, Buffer.from("bad"), inspected), /unsupported|limit/);
    assert.deepEqual(readdirSync(workspace).sort(), before);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
