import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import * as path from "path";

// before deploying. Enable model access in your target region first.
// Cross-region inference profile ID required for newer Anthropic models;
// on-demand throughput via the bare model ID is not supported.
const HAIKU_45_MODEL_ID = "au.anthropic.claude-haiku-4-5-20251001-v1:0";
const HAIKU_45_BASE_MODEL_ID = "anthropic.claude-haiku-4-5-20251001-v1:0";

export class AiHomeworkHelperStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
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

    const guardrailVersion = new bedrock.CfnGuardrailVersion(
      this,
      "HomeworkGuardrailVersion",
      { guardrailIdentifier: guardrail.attrGuardrailId },
    );

    // ── Cognito User Pool ──────────────────────────────────────────────────
    // Provides authentication for the kids' app. The Lambda validates the
    // Cognito-issued JWT on every request — unauthenticated calls never
    // reach Bedrock.
    const userPool = new cognito.UserPool(this, "HomeworkUserPool", {
      selfSignUpEnabled: true,
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
      memorySize: 512,
      timeout: cdk.Duration.minutes(5), // no longer bottlenecked by API GW's 29 s ceiling
      // Caps simultaneous in-flight agent loops across all users.
      // Each invocation holds a slot for the full agent duration (~10–30 s).
      // Excess requests receive a 429 throttle response before Lambda runs.
      // Raise this as real user load is measured.
      reservedConcurrentExecutions: 10,
      environment: {
        BEDROCK_MODEL_ID: HAIKU_45_MODEL_ID,
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
            imageDataDeliveryEnabled: false,
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
        allowedOrigins: ["*"],
        allowedMethods: [lambda.HttpMethod.POST],
        allowedHeaders: ["Content-Type", "Authorization"],
      },
    });

    // ── Outputs ───────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "FunctionUrl", {
      value: fnUrl.url,
      description: "POST to this URL with Authorization: Bearer <token>",
    });

    new cdk.CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId,
      description: "Cognito User Pool ID",
    });

    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId,
      description: "Cognito App Client ID (use in frontend)",
    });
  }
}
