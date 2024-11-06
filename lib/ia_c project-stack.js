require('dotenv').config();  // Load environment variables

const cdk = require('aws-cdk-lib');
const { Stack, Duration, RemovalPolicy, CfnOutput } = require('aws-cdk-lib');
const s3 = require('aws-cdk-lib/aws-s3');
const sqs = require('aws-cdk-lib/aws-sqs');
const cloudfront = require('aws-cdk-lib/aws-cloudfront');
const origins = require('aws-cdk-lib/aws-cloudfront-origins');
const autoscaling = require('aws-cdk-lib/aws-autoscaling');
const ec2 = require('aws-cdk-lib/aws-ec2');
const elbv2 = require('aws-cdk-lib/aws-elasticloadbalancingv2');
const apigateway = require('aws-cdk-lib/aws-apigateway');
const lambda = require('aws-cdk-lib/aws-lambda');
const ecs = require('aws-cdk-lib/aws-ecs');
const ecsPatterns = require('aws-cdk-lib/aws-ecs-patterns');

class IaCProjectStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // S3 Bucket
    const bucket = new s3.Bucket(this, 'AnimeWebsiteBucket', {
      bucketName: process.env.S3_BUCKET_NAME,
      removalPolicy: RemovalPolicy.DESTROY,
      publicReadAccess: true,
      websiteIndexDocument: 'index.html',
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS,
    });

    // CloudFront Distribution
    const distribution = new cloudfront.Distribution(this, 'AnimeWebsiteCDN', {
      defaultBehavior: { origin: new origins.S3StaticWebsiteOrigin(bucket) },
    });

    // SQS Queue
    const queue = new sqs.Queue(this, 'AnimeWebsiteQueue', {
      queueName: process.env.SQS_QUEUE_URL ? process.env.SQS_QUEUE_URL.split('/').pop() : 'DefaultQueueName',
      visibilityTimeout: Duration.seconds(300),
    });

    // VPC and Auto Scaling Group
    const vpc = new ec2.Vpc(this, 'AnimeWebsiteVpc', {
      maxAzs: 2,
    });

    const autoScalingGroup = new autoscaling.AutoScalingGroup(this, 'AnimeWebsiteASG', {
      vpc,
      instanceType: new ec2.InstanceType('t3.micro'),
      machineImage: new ec2.AmazonLinuxImage(),
      minCapacity: 1,
      maxCapacity: 10,
    });

    // Create an Application Load Balancer (ALB)
    const alb = new elbv2.ApplicationLoadBalancer(this, 'AnimeWebsiteALB', {
      vpc,
      internetFacing: true,
    });

    // Add a listener on port 80 for HTTP traffic
    const listener = alb.addListener('Listener', {
      port: 80,
      open: true,
    });

    // Attach the Auto Scaling Group to the ALB target group
    listener.addTargets('AnimeWebsiteTargets', {
      port: 80,
      targets: [autoScalingGroup],
      healthCheck: {
        path: '/',
      },
    });

    // Scaling Policy Based on Request Count per Target
    autoScalingGroup.scaleOnRequestCount('RequestCountScaling', {
      targetRequestsPerMinute: 200,
    });

    // Create an API Gateway
    const api = new apigateway.RestApi(this, 'AnimeWebsiteApi', {
      restApiName: 'Anime API',
      description: 'API Gateway for Anime Website',
      deployOptions: {
        stageName: 'prod',
      },
    });

    // Create a Lambda function for API handling
    const animeLambda = new lambda.Function(this, 'AnimeLambdaFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda'),  // Assuming you have code here
      environment: {
        TABLE_NAME: 'AnimeDataTable',
      },
    });

    // Integrate Lambda with API Gateway
    const animeResource = api.root.addResource('anime');
    animeResource.addMethod('GET', new apigateway.LambdaIntegration(animeLambda));

    // Create an ECS Cluster
    const cluster = new ecs.Cluster(this, 'AnimeEcsCluster', {
      vpc,
    });

    // Define a Fargate Task with a container image
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'AnimeTaskDefinition', {
      memoryLimitMiB: 512,
      cpu: 256,
    });

    // Add a container to the task definition
    const container = taskDefinition.addContainer('AnimeContainer', {
      image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),  // Replace with your container image
      logging: new ecs.AwsLogDriver({
        streamPrefix: 'AnimeContainerLogs',
      }),
    });

    // Add port mapping to the container
    container.addPortMappings({
      containerPort: 80,  // Port that the container listens on
      protocol: ecs.Protocol.TCP,
    });

    // Add a load-balanced Fargate Service
    new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'AnimeFargateService', {
      cluster,
      taskDefinition,
      publicLoadBalancer: true,
    });

    // Outputs
    new CfnOutput(this, 'S3BucketURL', { value: bucket.bucketWebsiteUrl });
    new CfnOutput(this, 'CloudFrontDistributionURL', { value: distribution.distributionDomainName });
    new CfnOutput(this, 'SQSQueueURL', { value: queue.queueUrl });
    new CfnOutput(this, 'LoadBalancerDNS', { value: alb.loadBalancerDnsName });
  }
}

module.exports = { IaCProjectStack };
