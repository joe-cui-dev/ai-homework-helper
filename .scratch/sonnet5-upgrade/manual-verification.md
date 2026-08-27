# Sonnet 5 Advanced Manual Verification

Complete these checks in `ap-southeast-2` after a user has accepted the Claude Sonnet 5 model agreement. Select **Advanced** for every workflow.

- [ ] Homework: upload one homework image and confirm every question receives a Coaching Packet.
- [ ] Reading: upload a book cover and content pages, then confirm five Reading Packets are produced.
- [ ] Writing: complete one `start` → `draft` → `question` → `end` workflow.
- [ ] Practice: start from a Homework result and complete one turn through `end_turn`.

If any workflow returns a Bedrock `ValidationException`, inspect the model ID, forced tool choice, `thinking` override, and (for InvokeModel) `temperature` together. Deploy rollback can override both model identifiers without code changes: `--context advancedModelId=au.anthropic.claude-sonnet-4-6 --context advancedBaseModelId=anthropic.claude-sonnet-4-6`.
