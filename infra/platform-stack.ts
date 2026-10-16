import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'node:path';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as logs from 'aws-cdk-lib/aws-logs';

interface PlatformProps extends StackProps {
  resourcePrefix: string;
}

/**
 * Everything that is shared by ALL tenants and deployed once.
 * Tenants (user pools, app clients, branding, IdPs) are created at runtime by
 * scripts/onboard.ts through the AWS SDK — adding a tenant never touches this stack.
 */
export class PlatformStack extends Stack {
  constructor(scope: Construct, id: string, props: PlatformProps) {
    super(scope, id, props);
    const root = process.cwd();
    const p = props.resourcePrefix;

    // ---------- Tenant registry ----------
    const table = new dynamodb.Table(this, 'TenantRegistry', {
      tableName: `${p}-tenants`,
      partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = (name: string, file: string) =>
      new NodejsFunction(this, name, {
        functionName: `${p}-${file}`,
        entry: path.join(root, 'lambda', `${file}.ts`),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: Duration.seconds(5),
        environment: { TENANT_TABLE: table.tableName },
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          logGroupName: `/aws/lambda/${p}-${file}`,
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        bundling: { minify: true, sourceMap: true, target: 'node22' },
      });

    // ---------- Cognito triggers (shared by every pool) ----------
    const preToken = fn('PreTokenFn', 'pre-token');
    const preAuth = fn('PreAuthFn', 'pre-auth');
    table.grantReadData(preToken);
    table.grantReadData(preAuth);
    // ONE account-scoped permission instead of one per pool: a per-pool SourceArn
    // statement would hit the 20 KB Lambda resource-policy limit at ~100+ pools.
    for (const f of [preToken, preAuth]) {
      f.addPermission('CognitoInvoke', {
        principal: new iam.ServicePrincipal('cognito-idp.amazonaws.com'),
        sourceAccount: this.account,
        action: 'lambda:InvokeFunction',
      });
    }

    // ---------- Sample API ----------
    const apiFn = fn('ApiFn', 'api');
    table.grantReadWriteData(apiFn); // theme editor saves (PUT /t/{id}/theme)
    const httpApi = new apigw.HttpApi(this, 'SampleApi', {
      apiName: `${p}-sample-api`,
      corsPreflight: {
        allowOrigins: ['*'], // bearer tokens only, no cookies
        allowHeaders: ['authorization', 'content-type'],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.PUT, apigw.CorsHttpMethod.OPTIONS],
        maxAge: Duration.hours(1),
      },
      defaultIntegration: new HttpLambdaIntegration('ApiIntegration', apiFn),
    });

    // ---------- Single-codebase SPA ----------
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const distribution = new cloudfront.Distribution(this, 'SiteCdn', {
      comment: `${p} multi-tenant login POC`,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      // SPA routing: /t/acme/... and /callback are client-side routes
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
        ttl: Duration.seconds(0),
      })),
    });

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
      sources: [
        s3deploy.Source.asset(path.join(root, 'frontend', 'dist')),
        // Runtime config so the SPA bundle itself has nothing environment-specific
        s3deploy.Source.jsonData('runtime-config.json', { apiUrl: httpApi.apiEndpoint, region: this.region }),
      ],
    });

    const out = (k: string, v: string) => new CfnOutput(this, k, { value: v });
    out('AppUrl', `https://${distribution.distributionDomainName}`);
    out('ApiUrl', httpApi.apiEndpoint);
    out('TenantTable', table.tableName);
    out('PreTokenFnArn', preToken.functionArn);
    out('PreAuthFnArn', preAuth.functionArn);
    out('Region', this.region);
    out('AccountId', this.account);
  }
}
