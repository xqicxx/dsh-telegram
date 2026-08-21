import test from 'node:test';
import assert from 'node:assert/strict';
import { Ephemeral } from '../dist/telegram/ephemeral.js';

// ---------------------------------------------------------------------------
// Issue: Models card taps felt dead — Ephemeral.replace() had a text+markup
// no-op early return, but `last` could point at a message deleted outside
// the cache, so the "no-op" swallowed the tap entirely.
// ---------------------------------------------------------------------------

function makeOps() {
  const ops = {
    sends: [],
    edits: [],
    deletes: [],
    /** Message ids that no longer exist on Telegram (deleted externally). */
    deletedIds: new Set(),
    /** When set, edits fail with Telegram's "message is not modified". */
    notModified: false,
    nextId: 500,
    async sendText(chatId, text, options) {
      const id = ops.nextId++;
      ops.sends.push({ chatId, text, options, id });
      return id;
    },
    async deleteMessage(chatId, messageId) {
      ops.deletes.push(messageId);
      ops.deletedIds.add(messageId);
    },
    async editText(chatId, messageId, text, options) {
      ops.edits.push({ chatId, messageId, text, options });
      if (ops.deletedIds.has(messageId)) return false; // "message to edit not found"
      // ops.notModified models the FIXED transport contract: Telegram's
      // "message is not modified" GrammyError is swallowed as success
      // (covered by the transport-level test below).
      void ops.notModified;
      return true;
    },
  };
  return ops;
}

test('a tap on a card whose message was deleted externally re-sends the card', async () => {
  const ops = makeOps();
  const eph = new Ephemeral();
  const first = await eph.replace(7, ops, 'Models card', {});
  assert.equal(first, 500);
  assert.equal(ops.sends.length, 1);

  // The user (or another path) deletes the message behind Ephemeral's back.
  ops.deletedIds.add(500);

  // Same text + same markup: the old code returned early as a "no-op" and
  // the tap did nothing at all. Now the failed edit clears state and the
  // card is re-sent fresh.
  const again = await eph.replace(7, ops, 'Models card', {});
  assert.equal(again, 501, 'a fresh message is sent');
  assert.equal(ops.sends.length, 2);
  assert.ok(ops.edits.some((edit) => edit.messageId === 500), 'the stale id was actually tried first');
});

test('an identical re-render of a live message does not duplicate the card', async () => {
  const ops = makeOps();
  const eph = new Ephemeral();
  await eph.replace(7, ops, 'Models card', {});
  ops.notModified = true; // message alive, content already the target state

  const id = await eph.replace(7, ops, 'Models card', {});
  assert.equal(id, 500, 'the live message id is kept');
  assert.equal(ops.sends.length, 1, 'no duplicate send — "not modified" is success');
  assert.equal(ops.edits.length, 1, 'the edit was attempted (no client-side no-op)');
});

test('a genuine edit failure still falls back to a fresh send', async () => {
  const ops = makeOps();
  const eph = new Ephemeral();
  await eph.replace(7, ops, 'card v1', {});
  ops.deletedIds.add(500);

  const id = await eph.replace(7, ops, 'card v2', {});
  assert.equal(id, 501);
  assert.equal(ops.sends.length, 2);
  // Cache now tracks the new message only.
  const id3 = await eph.replace(7, ops, 'card v3', {});
  assert.equal(id3, 501, 'subsequent edits target the new message in place');
  assert.equal(ops.sends.length, 2);
});
