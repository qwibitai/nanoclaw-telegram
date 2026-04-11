---
name: add-image-vision
description: Add image vision to NanoClaw agents. Images arriving via supported channels are downloaded, resized with sharp, and sent to Claude as multimodal content blocks so the agent sees them directly instead of just a file path.
---

# Image Vision Skill

Adds the ability for NanoClaw agents to see and understand images sent via supported channels. Images are downloaded, resized with sharp (<=1024px, JPEG q85), saved to the group workspace, and passed to the agent as base64-encoded multimodal content blocks.

**Supported channels:**
- **Telegram** — native support via `nanoclaw-telegram` (merge `telegram/skill/image-vision`)
- **WhatsApp** — native support via `nanoclaw-whatsapp` (merge `whatsapp/skill/image-vision`)

Both channels share the same channel-agnostic `src/image.ts` module and the same multimodal handling in the agent-runner. Adding image-vision to a new channel means writing ~30 lines in that channel's photo/image handler to call `processImageFile()` and emit the `[Image: attachments/...]` marker — the core pipeline is channel-independent.

## Phase 1: Pre-flight

1. Check if `src/image.ts` exists — skip to Phase 3 if already applied
2. Confirm `sharp` is installable (native bindings require build tools)
3. Identify which channel you're adding vision to — Telegram or WhatsApp — and use the matching skill branch below

**Prerequisite:** The matching channel must be installed first. Image-vision modifies channel-specific files (e.g. `src/channels/telegram.ts` or `src/channels/whatsapp.ts`).

## Phase 2: Apply Code Changes

### For Telegram

Ensure the telegram remote is present:

```bash
git remote -v
```

If `telegram` is missing, add it:

```bash
git remote add telegram https://github.com/qwibitai/nanoclaw-telegram.git
```

Merge the skill branch:

```bash
git fetch telegram skill/image-vision
git merge telegram/skill/image-vision || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/image.ts` (channel-agnostic: download, resize via sharp, base64 encoding, `parseImageReferences()`)
- Image attachment handling in `src/channels/telegram.ts` (new photo handler that calls `processImageFile()`)
- Updated `src/channels/telegram.test.ts` (mocks image.js, asserts new marker)
- Image passing to agent in `src/index.ts` (parseImageReferences call) and `src/container-runner.ts` (ContainerInput.imageAttachments)
- Image content block support in `container/agent-runner/src/index.ts` (types, MessageStream.pushMultimodal, runQuery loader)
- `sharp` npm dependency in `package.json`

### For WhatsApp

Ensure the whatsapp remote is present:

```bash
git remote -v
```

If `whatsapp` is missing, add it:

```bash
git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git
```

Merge the skill branch:

```bash
git fetch whatsapp skill/image-vision
git merge whatsapp/skill/image-vision || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in the whatsapp-specific channel handler and the same underlying `src/image.ts` pipeline. If you have both telegram and whatsapp installed, both photo handlers use the same `src/image.ts` module — so merging both skill branches is fine and the shared files resolve cleanly (or produce trivial conflicts you take from whichever side matches your working tree).

### In either case

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides. The sharp dependency and the core multimodal infrastructure are identical between the two skill branches; only the channel-specific photo handler file differs.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/image.test.ts
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Configure

1. Rebuild the container (agent-runner changes need a rebuild):
   ```bash
   ./container/build.sh
   ```

2. Sync agent-runner source to group caches:
   ```bash
   for dir in data/sessions/*/agent-runner-src/; do
     cp container/agent-runner/src/*.ts "$dir"
   done
   ```

3. Restart the service:
   ```bash
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```

## Phase 4: Verify

1. Send an image in a registered WhatsApp group
2. Check the agent responds with understanding of the image content
3. Check logs for "Processed image attachment":
   ```bash
   tail -50 groups/*/logs/container-*.log
   ```

## Troubleshooting

- **"Image - download failed"**: Check WhatsApp connection stability. The download may timeout on slow connections.
- **"Image - processing failed"**: Sharp may not be installed correctly. Run `npm ls sharp` to verify.
- **Agent doesn't mention image content**: Check container logs for "Loaded image" messages. If missing, ensure agent-runner source was synced to group caches.
