# ADR 0007 — Invite-only Parent Accounts with required SMS MFA

**Status:** Accepted
**Date:** 2026-05-31

## Context

The app stores child-related homework images, writing drafts, reading material, and coaching history. Although older code and storage keys use `studentId`, the authenticated Cognito identity is a Parent Account; the child is the subject of coaching, not the login identity.

The Cognito `sub` is embedded in S3 session keys. Replacing or deleting the User Pool would issue new `sub` values and make existing history inaccessible to the same parent unless a separate migration reconnects the old and new identifiers.

## Decision

Parent Accounts are invitation-only and are created by an administrator. Public sign-up and sign-up confirmation are not part of the product flow.

All Parent Accounts must use SMS MFA. First sign-in follows Cognito's challenge flow: temporary password, permanent password setup, SMS MFA, then app access. Returning sign-ins require SMS MFA whenever a fresh login is needed; remembered devices are not enabled.

Email remains the sign-in alias, Cognito invitation channel, and account recovery channel. Phone number is used only for SMS MFA; it is not a sign-in identifier and not an account recovery channel.

The Cognito User Pool remains a destructible CDK-managed resource and deletion protection is disabled. This keeps teardown simple for the current deployment stage, with the known trade-off that deleting the pool or replacing it will orphan history keyed by the old Cognito `sub`. The app client uses 120-minute access and ID tokens and a 30-day refresh token.

Because the current User Pool is being updated in place, `phone_number` cannot be changed into a required Cognito schema attribute. Instead, the operational contract is:

- Before enabling required SMS MFA, every existing Parent Account must have `phone_number` and `phone_number_verified=true` set by an administrator.
- Every newly-created Parent Account must be created with a verified phone number.
- The frontend does not provide a self-service phone-number migration flow.

The backend continues to validate Cognito JWTs only. It does not perform an additional MFA claim check; the User Pool's required MFA policy is the authentication boundary.

## Consequences

**Positive.**
- Parent access to child-related session history is protected by a second factor.
- The login model is simpler: there is one supported onboarding path, and all app access comes after MFA completion.
- The User Pool can still be torn down with the rest of the stack during this deployment stage.

**Negative.**
- Phone number completeness is enforced by administrator process rather than Cognito's immutable required-attribute schema.
- A parent who loses phone access can reset their password by email but still needs administrator help to replace the MFA phone number.
- SMS delivery has account-level operational dependencies: the Cognito SMS role is infrastructure, but SNS SMS production access, spend limits, and destination-country deliverability must be checked before rollout.
- A 30-day refresh token favours parent convenience over forcing frequent fresh MFA challenges.
- Deleting or replacing the User Pool orphans session history keyed by the old Cognito `sub`.

## Alternatives considered

- **Email MFA with email recovery.** Rejected because Cognito does not allow the same email address to be the MFA channel and the account recovery channel.
- **Email MFA with SMS recovery.** Rejected after choosing to keep email as the recovery channel and phone number as the second factor.
- **TOTP MFA with email recovery.** More secure and avoids SMS delivery dependencies, but rejected because the desired parent experience is an SMS code rather than authenticator-app setup.
- **Retaining the User Pool and enabling deletion protection.** Rejected for now to keep stack teardown simple. This can be revisited when preserving production account continuity matters more than teardown convenience.
- **Replacing the User Pool to make `phone_number` required.** Rejected for this change because new Cognito `sub` values would disconnect existing Parent Accounts from their session history.
- **Self-service phone migration.** Rejected to keep the rollout operationally controlled and avoid a pre-MFA state where users can alter their second factor from the browser.
