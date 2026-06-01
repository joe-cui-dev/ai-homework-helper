# Auth Rollout Checklist

Use this before deploying required SMS MFA for Parent Accounts.

## Cognito users

- List every existing Parent Account in the current Cognito User Pool.
- Set `phone_number` for each account in E.164 format, for example `+61400111222`.
- Set `phone_number_verified=true` for each account.
- Confirm each account still has a verified `email` for email-only password recovery.
- Create all new Parent Accounts through the administrator invitation flow with `email`, `email_verified=true`, `phone_number`, and `phone_number_verified=true`.

## SMS delivery

- Confirm the AWS account can send production SMS messages through SNS in the target region.
- Confirm the AWS account is not limited by the SNS SMS sandbox for the target recipients.
- Confirm the SMS spend limit is high enough for expected sign-in volume.
- Test delivery to representative destination countries before enabling MFA for real users.

## Deployment

- Deploy the CDK change that enables required SMS MFA only after the user migration checks pass.
- Keep the existing Cognito User Pool. Do not replace it, because session history is keyed by the Cognito `sub`.
- After deploy, test a fresh admin-created Parent Account through temporary password, permanent password setup, SMS MFA, and app access.
- Test a returning Parent Account through password sign-in, SMS MFA, and app access.
- Test email password recovery, then confirm the recovered account still requires SMS MFA before app access.
