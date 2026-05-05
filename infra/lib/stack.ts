import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cr from "aws-cdk-lib/custom-resources";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import * as path from "path";

// before deploying. Enable model access in your target region first.
// Cross-region inference profile ID required for newer Anthropic models;
// on-demand throughput via the bare model ID is not supported.
const HAIKU_45_MODEL_ID = "au.anthropic.claude-haiku-4-5-20251001-v1:0";
const HAIKU_45_BASE_MODEL_ID = "anthropic.claude-haiku-4-5-20251001-v1:0";

// AWS Bedrock pricing for Claude Haiku 4.5 — verify against the latest values
// at https://aws.amazon.com/bedrock/pricing/ when prices change. Quoted in USD
// per 1,000,000 tokens. Passed to both Lambdas via env vars so the backend can
// compute the dollar cost of each request server-side and surface it to the UI.
const HAIKU_45_INPUT_PRICE_PER_MTOK = "1.00";
const HAIKU_45_OUTPUT_PRICE_PER_MTOK = "5.00";

interface AiHomeworkHelperStackProps extends cdk.StackProps {
  portfolioDistributionId: string;
}

export class AiHomeworkHelperStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AiHomeworkHelperStackProps) {
    super(scope, id, props);

    // ── S3 bucket for session history ──────────────────────────────────────
    const sessionBucket = new s3.Bucket(this, "SessionBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          prefix: "sessions/",
          expiration: cdk.Duration.days(30),
        },
      ],
    });

    // ── S3 bucket for frontend assets ─────────────────────────────────────
    const frontendBucket = new s3.Bucket(this, "FrontendBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ── Bedrock Guardrail ──────────────────────────────────────────────────
    // Protects the kids' app from harmful content, profanity, PII exposure,
    // and off-topic abuse (roleplay, code generation, etc.).
    const guardrail = new bedrock.CfnGuardrail(this, "HomeworkGuardrail", {
      name: "HomeworkHelperGuardrail",
      description: "Safety guardrail for AI Homework Helper — kids app",
      blockedInputMessaging:
        "I'm not able to help with that. Please ask me a homework question!",
      blockedOutputsMessaging:
        "I'm not able to share that response. Please try a different question.",
      contentPolicyConfig: {
        filtersConfig: [
          { type: "HATE", inputStrength: "HIGH", outputStrength: "HIGH" },
          { type: "INSULTS", inputStrength: "HIGH", outputStrength: "HIGH" },
          { type: "SEXUAL", inputStrength: "HIGH", outputStrength: "HIGH" },
          { type: "VIOLENCE", inputStrength: "HIGH", outputStrength: "HIGH" },
          // Blocks drug references and illegal activity — appropriate for a kids' app.
          { type: "MISCONDUCT", inputStrength: "HIGH", outputStrength: "HIGH" },
          // Blocks jailbreak / prompt-injection attempts at the model level,
          // complementing the OffTopic topic policy.
          {
            type: "PROMPT_ATTACK",
            inputStrength: "HIGH",
            outputStrength: "NONE",
          },
        ],
      },
      wordPolicyConfig: {
        managedWordListsConfig: [{ type: "PROFANITY" }],
      },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          // NAME and AGE are intentionally omitted: word problems routinely
          // contain both (e.g. "Nick has a garden...", "Emma is 9 years old...")
          // and blocking them would reject legitimate homework questions.
          { type: "EMAIL", action: "BLOCK" },
          { type: "PHONE", action: "BLOCK" },
          { type: "ADDRESS", action: "BLOCK" },
        ],
      },
      topicPolicyConfig: {
        topicsConfig: [
          {
            name: "OffTopic",
            definition:
              "Any request not related to student homework or learning, " +
              "including roleplay, creative fiction, code generation, " +
              "personal advice, or requests to ignore previous instructions.",
            examples: [
              "pretend you are a pirate",
              "write me a Python script",
              "ignore your previous instructions",
              "tell me a story unrelated to school",
            ],
            type: "DENY",
          },
        ],
      },
    });

    // CfnGuardrailVersion creates an immutable snapshot of the guardrail at
    // deploy time. CloudFormation never updates a version resource — it can
    // only replace it. To force replacement whenever the guardrail definition
    // changes, we:
    //   1. Set a description that embeds a hash of the guardrail's synthesised
    //      JSON, so the description (and therefore the resource) changes with
    //      every guardrail edit.
    //   2. Set the removal policy to RETAIN so old versions are not deleted
    //      while the Lambda may still be mid-request on an in-flight deploy.
    const guardrailHash = cdk.Names.uniqueResourceName(guardrail, {
      maxLength: 16,
    });
    const guardrailVersion = new bedrock.CfnGuardrailVersion(
      this,
      "HomeworkGuardrailVersion",
      {
        guardrailIdentifier: guardrail.attrGuardrailId,
        description: `hash-${guardrailHash}`,
      },
    );
    guardrailVersion.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // ── Cognito User Pool ──────────────────────────────────────────────────
    // Provides authentication for the kids' app. The Lambda validates the
    // Cognito-issued JWT on every request — unauthenticated calls never
    // reach Bedrock.
    const userPool = new cognito.UserPool(this, "HomeworkUserPool", {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // SPA client — no client secret (public client, runs in browser)
    const userPoolClient = new cognito.UserPoolClient(
      this,
      "HomeworkUserPoolClient",
      {
        userPool,
        authFlows: {
          userPassword: true,
          userSrp: true,
        },
        generateSecret: false,
      },
    );

    // ── Lambda function ────────────────────────────────────────────────────
    const lambdaLogGroup = new logs.LogGroup(this, "SolveFunctionLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambdaNodejs.NodejsFunction(this, "SolveFunction", {
      logGroup: lambdaLogGroup,
      entry: path.join(__dirname, "../../backend/src/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      memorySize: 1024,
      timeout: cdk.Duration.minutes(5), // no longer bottlenecked by API GW's 29 s ceiling
      // Caps simultaneous in-flight agent loops across all users.
      // Each invocation holds a slot for the full agent duration (~10–30 s).
      // Excess requests receive a 429 throttle response before Lambda runs.
      // Raise this as real user load is measured.
      reservedConcurrentExecutions: 10,
      environment: {
        BEDROCK_MODEL_ID: HAIKU_45_MODEL_ID,
        BEDROCK_INPUT_PRICE_PER_MTOK: HAIKU_45_INPUT_PRICE_PER_MTOK,
        BEDROCK_OUTPUT_PRICE_PER_MTOK: HAIKU_45_OUTPUT_PRICE_PER_MTOK,
        S3_BUCKET_NAME: sessionBucket.bucketName,
        BEDROCK_GUARDRAIL_ID: guardrail.attrGuardrailId,
        BEDROCK_GUARDRAIL_VERSION: guardrailVersion.attrVersion,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_APP_CLIENT_ID: userPoolClient.userPoolClientId,
        SERVICE_NAME: "ai-homework-helper",
        LOG_LEVEL: this.node.tryGetContext("logLevel") ?? "DEBUG",
      },
      bundling: {
        minify: true,
        sourceMap: false,
      },
    });

    // ── IAM: Bedrock ───────────────────────────────────────────────────────
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ],
        resources: [
          // Foundation model — required even when invoked via an inference profile
          `arn:aws:bedrock:*::foundation-model/${HAIKU_45_BASE_MODEL_ID}`,
          // Cross-region inference profile
          `arn:aws:bedrock:*:*:inference-profile/${HAIKU_45_MODEL_ID}`,
        ],
      }),
    );

    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:ApplyGuardrail"],
        resources: [guardrail.attrGuardrailArn],
      }),
    );

    // ── IAM: S3 ───────────────────────────────────────────────────────────
    sessionBucket.grantPut(fn, "sessions/*");
    sessionBucket.grantRead(fn, "sessions/*");

    // ── History Lambda ────────────────────────────────────────────────────
    // Separate function so the history read path never contends with the
    // solve path's reserved concurrency slots, and keeps handler.ts clean.
    const historyLogGroup = new logs.LogGroup(this, "HistoryFunctionLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const historyFn = new lambdaNodejs.NodejsFunction(this, "HistoryFunction", {
      logGroup: historyLogGroup,
      entry: path.join(__dirname, "../../backend/src/history-handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: {
        S3_BUCKET_NAME: sessionBucket.bucketName,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_APP_CLIENT_ID: userPoolClient.userPoolClientId,
        SERVICE_NAME: "ai-homework-helper",
        LOG_LEVEL: this.node.tryGetContext("logLevel") ?? "DEBUG",
      },
      bundling: {
        minify: true,
        sourceMap: false,
      },
    });

    // Read covers s3:GetObject + s3:ListBucket needed for listSessions and
    // getSignedUrl (pre-signed URLs are signed with the Lambda role's credentials).
    sessionBucket.grantRead(historyFn, "sessions/*");

    const historyFnUrl = new lambda.FunctionUrl(this, "HistoryFunctionUrl", {
      function: historyFn,
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: [
          this.node.tryGetContext("allowedOrigin") ?? "https://joe-cui.com",
        ],
        allowedMethods: [lambda.HttpMethod.GET],
        allowedHeaders: ["Content-Type", "Authorization"],
      },
    });

    // ── Bedrock Model Invocation Logging ───────────────────────────────────
    // Bedrock invocation logging is a region-level setting with no native CFN
    // resource. We drive it via a CDK custom resource (AwsCustomResource) which
    // calls the Bedrock SDK PutModelInvocationLoggingConfiguration on deploy and
    // DeleteModelInvocationLoggingConfiguration on destroy.
    const invocationLogGroup = new logs.LogGroup(
      this,
      "BedrockInvocationLogs",
      {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );

    const bedrockLoggingRole = new iam.Role(this, "BedrockLoggingRole", {
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com"),
      inlinePolicies: {
        CloudWatchLogsWrite: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
              resources: [invocationLogGroup.logGroupArn],
            }),
          ],
        }),
      },
    });

    // Grant the custom resource Lambda permission to call the Bedrock logging API

    new cr.AwsCustomResource(this, "BedrockLoggingConfig", {
      onUpdate: {
        service: "@aws-sdk/client-bedrock",
        action: "PutModelInvocationLoggingConfigurationCommand",
        parameters: {
          loggingConfig: {
            cloudWatchConfig: {
              logGroupName: invocationLogGroup.logGroupName,
              roleArn: bedrockLoggingRole.roleArn,
            },
            textDataDeliveryEnabled: true,
            embeddingDataDeliveryEnabled: false,
            imageDataDeliveryEnabled: true,
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of("BedrockLoggingConfig"),
      },
      onDelete: {
        service: "@aws-sdk/client-bedrock",
        action: "DeleteModelInvocationLoggingConfigurationCommand",
        parameters: {},
        physicalResourceId: cr.PhysicalResourceId.of("BedrockLoggingConfig"),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            "bedrock:PutModelInvocationLoggingConfiguration",
            "bedrock:DeleteModelInvocationLoggingConfiguration",
          ],
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          actions: ["iam:PassRole"],
          resources: [bedrockLoggingRole.roleArn],
        }),
      ]),
    });

    // ── Practice Lambda (Phase 2: Practice Tutor Loop) ─────────────────────
    // Multi-turn agentic loop. Each parent turn = one POST. State lives in S3
    // (sessions/{studentId}/{batchId}/practice-{questionId}.json), Lambda is
    // stateless between turns.
    const practiceLogGroup = new logs.LogGroup(this, "PracticeFunctionLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const practiceFn = new lambdaNodejs.NodejsFunction(this, "PracticeFunction", {
      logGroup: practiceLogGroup,
      entry: path.join(__dirname, "../../backend/src/practice-handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      memorySize: 1024,
      timeout: cdk.Duration.minutes(5),
      // Smaller cap than Solve — practice turns are individually shorter
      // (no vision call), but each session generates many turns over time.
      reservedConcurrentExecutions: 5,
      environment: {
        BEDROCK_MODEL_ID: HAIKU_45_MODEL_ID,
        BEDROCK_INPUT_PRICE_PER_MTOK: HAIKU_45_INPUT_PRICE_PER_MTOK,
        BEDROCK_OUTPUT_PRICE_PER_MTOK: HAIKU_45_OUTPUT_PRICE_PER_MTOK,
        S3_BUCKET_NAME: sessionBucket.bucketName,
        BEDROCK_GUARDRAIL_ID: guardrail.attrGuardrailId,
        BEDROCK_GUARDRAIL_VERSION: guardrailVersion.attrVersion,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_APP_CLIENT_ID: userPoolClient.userPoolClientId,
        SERVICE_NAME: "ai-homework-helper",
        LOG_LEVEL: this.node.tryGetContext("logLevel") ?? "DEBUG",
      },
      bundling: {
        minify: true,
        sourceMap: false,
      },
    });

    practiceFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ],
        resources: [
          `arn:aws:bedrock:*::foundation-model/${HAIKU_45_BASE_MODEL_ID}`,
          `arn:aws:bedrock:*:*:inference-profile/${HAIKU_45_MODEL_ID}`,
        ],
      }),
    );

    practiceFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:ApplyGuardrail"],
        resources: [guardrail.attrGuardrailArn],
      }),
    );

    // Practice Lambda needs read+write on sessions/* (load source packet, list
    // practice siblings, write practice session JSON).
    sessionBucket.grantPut(practiceFn, "sessions/*");
    sessionBucket.grantRead(practiceFn, "sessions/*");

    // History Lambda now also reads the practice-*.json siblings to surface
    // "Practice ✓" pills — no extra IAM needed since it already has Read on
    // sessions/*.

    const practiceFnUrl = new lambda.FunctionUrl(this, "PracticeFunctionUrl", {
      function: practiceFn,
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
      cors: {
        allowedOrigins: [
          this.node.tryGetContext("allowedOrigin") ?? "https://joe-cui.com",
        ],
        allowedMethods: [lambda.HttpMethod.POST],
        allowedHeaders: ["Content-Type", "Authorization"],
      },
    });

    // ── Lambda Function URL (streaming) ───────────────────────────────────
    // Response streaming removes the API Gateway timeout ceiling and lets the
    // client receive tool-progress events incrementally before the final result.
    // Authentication is handled inside the Lambda via Cognito JWT validation,
    // so authType stays NONE (required for streaming).
    const fnUrl = new lambda.FunctionUrl(this, "SolveFunctionUrl", {
      function: fn,
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
      cors: {
        allowedOrigins: [
          this.node.tryGetContext("allowedOrigin") ?? "https://joe-cui.com",
        ],
        allowedMethods: [lambda.HttpMethod.POST],
        allowedHeaders: ["Content-Type", "Authorization"],
      },
    });

    // ── CloudFront Function (SPA routing) ────────────────────────────────

    // CloudFront Function to rewrite SPA routes. The portfolio distribution serves
    // multiple SPA apps, so we route /ai-homework-helper/* to the homework helper
    // index.html, and let the frontend router handle it from there. All other
    // paths are left alone (e.g. /blog/* goes to the blog SPA, /index.html
    // goes to the root SPA, /api/* goes to the API Gateway, etc.).
    const spaRewriteFunction = new cloudfront.Function(
      this,
      "SpaRewriteFunction",
      {
        // The function code is a simple URI rewrite that directs all /ai-homework-helper/* requests to /ai-homework-helper/index.html,
        // allowing the frontend router to handle SPA routing. All other URIs are passed through unchanged.
        code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.match(/\\.\\w+$/)) return request;
  if (uri.startsWith('/ai-homework-helper')) {
    request.uri = '/ai-homework-helper/index.html';
  }
  return request;
}
`),
        runtime: cloudfront.FunctionRuntime.JS_2_0,
      },
    );

    // OAC for the portfolio distribution to access the frontend bucket.
    // Select this OAC when adding the S3 origin in the CloudFront console.
    const oac = new cloudfront.S3OriginAccessControl(this, "FrontendOAC");

    // Bucket policy: grant the portfolio distribution read access via OAC.
    frontendBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
        resources: [frontendBucket.arnForObjects("*")],
        conditions: {
          StringEquals: {
            "AWS:SourceArn": `arn:aws:cloudfront::${this.account}:distribution/${props.portfolioDistributionId}`,
          },
        },
      }),
    );

    // Import the existing portfolio distribution for BucketDeployment cache invalidation.
    const portfolioDistribution =
      cloudfront.Distribution.fromDistributionAttributes(
        this,
        "PortfolioDistribution",
        {
          distributionId: props.portfolioDistributionId,
          domainName: "joe-cui.com",
        },
      );

    new s3deploy.BucketDeployment(this, "FrontendDeployment", {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, "../../frontend/dist")),
      ],
      destinationBucket: frontendBucket,
      destinationKeyPrefix: "ai-homework-helper",
      distribution: portfolioDistribution,
      distributionPaths: ["/ai-homework-helper/*"],
      memoryLimit: 512,
      prune: true,
    });

    // ── Outputs ───────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "FunctionUrl", {
      value: fnUrl.url,
      description: "POST to this URL with Authorization: Bearer <token>",
    });

    new cdk.CfnOutput(this, "HistoryApiUrl", {
      value: historyFnUrl.url,
      description: "GET /sessions — history browser endpoint",
    });

    new cdk.CfnOutput(this, "PracticeApiUrl", {
      value: practiceFnUrl.url,
      description:
        "POST /practice/start | /practice/turn | /practice/end — Phase 2 Practice Tutor Loop",
    });

    new cdk.CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId,
      description: "Cognito User Pool ID",
    });

    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId,
      description: "Cognito App Client ID (use in frontend)",
    });

    new cdk.CfnOutput(this, "FrontendBucketName", {
      value: frontendBucket.bucketName,
      description: "S3 bucket — select as the origin in CloudFront console",
    });

    new cdk.CfnOutput(this, "OACId", {
      value: oac.originAccessControlId,
      description:
        "OAC ID — select when adding the S3 origin in CloudFront console",
    });

    new cdk.CfnOutput(this, "SpaFunctionArn", {
      value: spaRewriteFunction.functionArn,
      description:
        "CloudFront Function ARN — attach to the /ai-homework-helper* behavior (viewer-request)",
    });
  }
}
