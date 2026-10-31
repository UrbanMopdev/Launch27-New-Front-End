## What changed

## Why

## How it was tested
- [ ] `npm run check` passes locally
- [ ] Tried on the dev environment

## Database
- [ ] No migration
- [ ] New migration in `server/migrations/` (never edit an applied one); backwards compatible with the code currently in production (see docs/database.md)

## Risk and rollback
<!-- What could break, and how to undo it. -->

## Checklist
- [ ] No secrets, `.env` files, or real customer data added
- [ ] No live SMS/email/notification paths reachable outside production
