#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AiHomeworkHelperStack } from "../lib/stack";

const app = new cdk.App();

new AiHomeworkHelperStack(app, "AiHomeworkHelperStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "ap-southeast-2",
  },
  portfolioDistributionId: app.node.getContext("portfolioDistributionId"),
});
