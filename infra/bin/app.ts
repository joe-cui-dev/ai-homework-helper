#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AiHomeworkHelperStack } from "../lib/stack";

const app = new cdk.App();

const siteCertArn = process.env.SITE_CERT_ARN;
if (!siteCertArn) {
  throw new Error(
    "SITE_CERT_ARN is required. Add it to infra/.env (see .env.example).",
  );
}

new AiHomeworkHelperStack(app, "AiHomeworkHelperStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "ap-southeast-2",
  },
  siteCertArn,
});
