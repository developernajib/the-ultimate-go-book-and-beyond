## 102.3 Pulumi with Go

### Project Setup

Pulumi's Go SDK lets you express an entire cloud stack, VPC, EKS cluster, ECR registry, RDS database, and Kubernetes workloads, in a single typed Go program, eliminating the context-switch between application code and a separate DSL. The `pulumi.Run` entry point registers a deployment function that Pulumi calls with a `Context` used to track resource dependencies. outputs like `vpc.ID()` are lazy `Output[T]` values that Pulumi resolves in dependency order, automatically sequencing resource creation without explicit `depends_on` declarations.

```go
// main.go
package main

import (
    "fmt"

    "github.com/pulumi/pulumi-aws/sdk/v6/go/aws/ec2"
    "github.com/pulumi/pulumi-aws/sdk/v6/go/aws/ecr"
    "github.com/pulumi/pulumi-aws/sdk/v6/go/aws/eks"
    "github.com/pulumi/pulumi-aws/sdk/v6/go/aws/iam"
    "github.com/pulumi/pulumi-aws/sdk/v6/go/aws/rds"
    "github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes"
    appsv1 "github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes/apps/v1"
    corev1 "github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes/core/v1"
    metav1 "github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes/meta/v1"
    "github.com/pulumi/pulumi/sdk/v3/go/pulumi"
    "github.com/pulumi/pulumi/sdk/v3/go/pulumi/config"
)

func main() {
    pulumi.Run(func(ctx *pulumi.Context) error {
        // Load configuration
        cfg := config.New(ctx, "")
        environment := cfg.Require("environment")
        projectName := cfg.Require("projectName")

        // Create VPC
        vpc, err := createVPC(ctx, projectName, environment)
        if err != nil {
            return err
        }

        // Create EKS cluster
        cluster, err := createEKSCluster(ctx, projectName, environment, vpc)
        if err != nil {
            return err
        }

        // Create ECR repository
        repo, err := createECRRepository(ctx, projectName)
        if err != nil {
            return err
        }

        // Create RDS instance
        dbInstance, err := createRDSInstance(ctx, projectName, environment, vpc)
        if err != nil {
            return err
        }

        // Deploy Go service to Kubernetes
        err = deployGoService(ctx, cluster, repo, projectName, environment)
        if err != nil {
            return err
        }

        // Outputs
        ctx.Export("vpcId", vpc.VPC.ID())
        ctx.Export("clusterName", cluster.Name)
        ctx.Export("ecrRepositoryUrl", repo.RepositoryUrl)
        ctx.Export("dbEndpoint", dbInstance.Endpoint)

        return nil
    })
}

type VPCResult struct {
    VPC            *ec2.Vpc
    PublicSubnets  []*ec2.Subnet
    PrivateSubnets []*ec2.Subnet
}

func createVPC(ctx *pulumi.Context, projectName, environment string) (*VPCResult, error) {
    // Create VPC
    vpc, err := ec2.NewVpc(ctx, fmt.Sprintf("%s-%s-vpc", projectName, environment), &ec2.VpcArgs{
        CidrBlock:          pulumi.String("10.0.0.0/16"),
        EnableDnsHostnames: pulumi.Bool(true),
        EnableDnsSupport:   pulumi.Bool(true),
        Tags: pulumi.StringMap{
            "Name": pulumi.Sprintf("%s-%s-vpc", projectName, environment),
        },
    })
    if err != nil {
        return nil, err
    }

    // Create Internet Gateway
    igw, err := ec2.NewInternetGateway(ctx, fmt.Sprintf("%s-%s-igw", projectName, environment), &ec2.InternetGatewayArgs{
        VpcId: vpc.ID(),
        Tags: pulumi.StringMap{
            "Name": pulumi.Sprintf("%s-%s-igw", projectName, environment),
        },
    })
    if err != nil {
        return nil, err
    }

    // Create subnets
    azs := []string{"a", "b", "c"}
    var publicSubnets, privateSubnets []*ec2.Subnet

    for i, az := range azs {
        // Public subnet
        publicSubnet, err := ec2.NewSubnet(ctx, fmt.Sprintf("%s-%s-public-%s", projectName, environment, az), &ec2.SubnetArgs{
            VpcId:               vpc.ID(),
            CidrBlock:           pulumi.Sprintf("10.0.%d.0/24", i+1),
            AvailabilityZone:    pulumi.Sprintf("us-west-2%s", az),
            MapPublicIpOnLaunch: pulumi.Bool(true),
            Tags: pulumi.StringMap{
                "Name":                   pulumi.Sprintf("%s-%s-public-%s", projectName, environment, az),
                "kubernetes.io/role/elb": pulumi.String("1"),
            },
        })
        if err != nil {
            return nil, err
        }
        publicSubnets = append(publicSubnets, publicSubnet)

        // Private subnet
        privateSubnet, err := ec2.NewSubnet(ctx, fmt.Sprintf("%s-%s-private-%s", projectName, environment, az), &ec2.SubnetArgs{
            VpcId:            vpc.ID(),
            CidrBlock:        pulumi.Sprintf("10.0.%d.0/24", i+101),
            AvailabilityZone: pulumi.Sprintf("us-west-2%s", az),
            Tags: pulumi.StringMap{
                "Name":                            pulumi.Sprintf("%s-%s-private-%s", projectName, environment, az),
                "kubernetes.io/role/internal-elb": pulumi.String("1"),
            },
        })
        if err != nil {
            return nil, err
        }
        privateSubnets = append(privateSubnets, privateSubnet)
    }

    // Create NAT Gateway (for private subnet internet access)
    eip, err := ec2.NewEip(ctx, fmt.Sprintf("%s-%s-nat-eip", projectName, environment), &ec2.EipArgs{
        Domain: pulumi.String("vpc"),
    })
    if err != nil {
        return nil, err
    }

    natGw, err := ec2.NewNatGateway(ctx, fmt.Sprintf("%s-%s-nat", projectName, environment), &ec2.NatGatewayArgs{
        AllocationId: eip.ID(),
        SubnetId:     publicSubnets[0].ID(),
        Tags: pulumi.StringMap{
            "Name": pulumi.Sprintf("%s-%s-nat", projectName, environment),
        },
    })
    if err != nil {
        return nil, err
    }

    // Route tables
    publicRT, err := ec2.NewRouteTable(ctx, fmt.Sprintf("%s-%s-public-rt", projectName, environment), &ec2.RouteTableArgs{
        VpcId: vpc.ID(),
        Routes: ec2.RouteTableRouteArray{
            &ec2.RouteTableRouteArgs{
                CidrBlock: pulumi.String("0.0.0.0/0"),
                GatewayId: igw.ID(),
            },
        },
    })
    if err != nil {
        return nil, err
    }

    privateRT, err := ec2.NewRouteTable(ctx, fmt.Sprintf("%s-%s-private-rt", projectName, environment), &ec2.RouteTableArgs{
        VpcId: vpc.ID(),
        Routes: ec2.RouteTableRouteArray{
            &ec2.RouteTableRouteArgs{
                CidrBlock:    pulumi.String("0.0.0.0/0"),
                NatGatewayId: natGw.ID(),
            },
        },
    })
    if err != nil {
        return nil, err
    }

    // Associate subnets with route tables
    for i, subnet := range publicSubnets {
        _, err = ec2.NewRouteTableAssociation(ctx, fmt.Sprintf("%s-%s-public-rta-%d", projectName, environment, i), &ec2.RouteTableAssociationArgs{
            SubnetId:     subnet.ID(),
            RouteTableId: publicRT.ID(),
        })
        if err != nil {
            return nil, err
        }
    }

    for i, subnet := range privateSubnets {
        _, err = ec2.NewRouteTableAssociation(ctx, fmt.Sprintf("%s-%s-private-rta-%d", projectName, environment, i), &ec2.RouteTableAssociationArgs{
            SubnetId:     subnet.ID(),
            RouteTableId: privateRT.ID(),
        })
        if err != nil {
            return nil, err
        }
    }

    return &VPCResult{
        VPC:            vpc,
        PublicSubnets:  publicSubnets,
        PrivateSubnets: privateSubnets,
    }, nil
}

func createEKSClusterRole(ctx *pulumi.Context, projectName, environment string) (*iam.Role, error) {
    return iam.NewRole(ctx, fmt.Sprintf("%s-%s-eks-role", projectName, environment), &iam.RoleArgs{
        AssumeRolePolicy: pulumi.String(`{
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Principal": {"Service": "eks.amazonaws.com"},
                "Action": "sts:AssumeRole"
            }]
        }`),
        Tags: pulumi.StringMap{
            "Name": pulumi.Sprintf("%s-%s-eks-role", projectName, environment),
        },
    })
}

func createEKSCluster(ctx *pulumi.Context, projectName, environment string, vpc *VPCResult) (*eks.Cluster, error) {
    // Create EKS cluster role
    clusterRole, err := createEKSClusterRole(ctx, projectName, environment)
    if err != nil {
        return nil, err
    }

    // Get subnet IDs
    var subnetIds pulumi.StringArray
    for _, subnet := range vpc.PrivateSubnets {
        subnetIds = append(subnetIds, subnet.ID())
    }
    for _, subnet := range vpc.PublicSubnets {
        subnetIds = append(subnetIds, subnet.ID())
    }

    // Create EKS cluster
    cluster, err := eks.NewCluster(ctx, fmt.Sprintf("%s-%s", projectName, environment), &eks.ClusterArgs{
        RoleArn: clusterRole.Arn,
        VpcConfig: &eks.ClusterVpcConfigArgs{
            SubnetIds: subnetIds,
        },
        Version: pulumi.String("1.28"),
    })
    if err != nil {
        return nil, err
    }

    return cluster, nil
}

func createECRRepository(ctx *pulumi.Context, projectName string) (*ecr.Repository, error) {
    repo, err := ecr.NewRepository(ctx, projectName, &ecr.RepositoryArgs{
        Name:               pulumi.String(projectName),
        ImageTagMutability: pulumi.String("IMMUTABLE"),
        ImageScanningConfiguration: &ecr.RepositoryImageScanningConfigurationArgs{
            ScanOnPush: pulumi.Bool(true),
        },
    })
    if err != nil {
        return nil, err
    }

    // Lifecycle policy
    _, err = ecr.NewLifecyclePolicy(ctx, fmt.Sprintf("%s-lifecycle", projectName), &ecr.LifecyclePolicyArgs{
        Repository: repo.Name,
        Policy: pulumi.String(`{
            "rules": [
                {
                    "rulePriority": 1,
                    "description": "Keep last 30 images",
                    "selection": {
                        "tagStatus": "any",
                        "countType": "imageCountMoreThan",
                        "countNumber": 30
                    },
                    "action": {
                        "type": "expire"
                    }
                }
            ]
        }`),
    })
    if err != nil {
        return nil, err
    }

    return repo, nil
}

func createRDSInstance(ctx *pulumi.Context, projectName, environment string, vpc *VPCResult) (*rds.Instance, error) {
    // Subnet group
    var subnetIds pulumi.StringArray
    for _, subnet := range vpc.PrivateSubnets {
        subnetIds = append(subnetIds, subnet.ID())
    }

    subnetGroup, err := rds.NewSubnetGroup(ctx, fmt.Sprintf("%s-%s", projectName, environment), &rds.SubnetGroupArgs{
        SubnetIds: subnetIds,
    })
    if err != nil {
        return nil, err
    }

    // Security group
    sg, err := ec2.NewSecurityGroup(ctx, fmt.Sprintf("%s-%s-rds-sg", projectName, environment), &ec2.SecurityGroupArgs{
        VpcId: vpc.VPC.ID(),
        Ingress: ec2.SecurityGroupIngressArray{
            &ec2.SecurityGroupIngressArgs{
                Protocol:   pulumi.String("tcp"),
                FromPort:   pulumi.Int(5432),
                ToPort:     pulumi.Int(5432),
                CidrBlocks: pulumi.StringArray{pulumi.String("10.0.0.0/16")},
            },
        },
    })
    if err != nil {
        return nil, err
    }

    // RDS instance
    instance, err := rds.NewInstance(ctx, fmt.Sprintf("%s-%s", projectName, environment), &rds.InstanceArgs{
        Identifier:        pulumi.Sprintf("%s-%s", projectName, environment),
        Engine:            pulumi.String("postgres"),
        EngineVersion:     pulumi.String("15.4"),
        InstanceClass:     pulumi.String("db.t3.micro"),
        AllocatedStorage:  pulumi.Int(20),
        StorageEncrypted:  pulumi.Bool(true),
        DbName:            pulumi.String(projectName),
        Username:          pulumi.String("admin"),
        Password:          pulumi.String("change-me-in-production"), // Use secrets manager
        DbSubnetGroupName: subnetGroup.Name,
        VpcSecurityGroupIds: pulumi.StringArray{
            sg.ID(),
        },
        SkipFinalSnapshot: pulumi.Bool(environment != "prod"),
    })
    if err != nil {
        return nil, err
    }

    return instance, nil
}

func generateKubeconfig(cluster *eks.Cluster) pulumi.StringOutput {
    return pulumi.Sprintf(`apiVersion: v1
clusters:
- cluster:
    server: %s
    certificate-authority-data: %s
  name: kubernetes
contexts:
- context:
    cluster: kubernetes
    user: aws
  name: aws
current-context: aws
kind: Config
preferences: {}
users:
- name: aws
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args:
        - "eks"
        - "get-token"
        - "--cluster-name"
        - "%s"
`, cluster.Endpoint, cluster.CertificateAuthority.Data().Elem(), cluster.Name)
}

func deployGoService(ctx *pulumi.Context, cluster *eks.Cluster, repo *ecr.Repository, projectName, environment string) error {
    // Create Kubernetes provider using EKS cluster
    k8sProvider, err := kubernetes.NewProvider(ctx, "k8s", &kubernetes.ProviderArgs{
        Kubeconfig: generateKubeconfig(cluster),
    })
    if err != nil {
        return err
    }

    // Create namespace
    ns, err := corev1.NewNamespace(ctx, projectName, &corev1.NamespaceArgs{
        Metadata: &metav1.ObjectMetaArgs{
            Name: pulumi.String(projectName),
        },
    }, pulumi.Provider(k8sProvider))
    if err != nil {
        return err
    }

    // Create deployment
    labels := pulumi.StringMap{
        "app": pulumi.String(projectName),
    }

    replicas := 3
    if environment != "prod" {
        replicas = 2
    }

    _, err = appsv1.NewDeployment(ctx, projectName, &appsv1.DeploymentArgs{
        Metadata: &metav1.ObjectMetaArgs{
            Name:      pulumi.String(projectName),
            Namespace: ns.Metadata.Name(),
        },
        Spec: &appsv1.DeploymentSpecArgs{
            Replicas: pulumi.Int(replicas),
            Selector: &metav1.LabelSelectorArgs{
                MatchLabels: labels,
            },
            Template: &corev1.PodTemplateSpecArgs{
                Metadata: &metav1.ObjectMetaArgs{
                    Labels: labels,
                },
                Spec: &corev1.PodSpecArgs{
                    Containers: corev1.ContainerArray{
                        &corev1.ContainerArgs{
                            Name:  pulumi.String(projectName),
                            Image: pulumi.Sprintf("%s:latest", repo.RepositoryUrl),
                            Ports: corev1.ContainerPortArray{
                                &corev1.ContainerPortArgs{
                                    ContainerPort: pulumi.Int(8080),
                                },
                            },
                            Resources: &corev1.ResourceRequirementsArgs{
                                Requests: pulumi.StringMap{
                                    "cpu":    pulumi.String("100m"),
                                    "memory": pulumi.String("128Mi"),
                                },
                                Limits: pulumi.StringMap{
                                    "cpu":    pulumi.String("500m"),
                                    "memory": pulumi.String("512Mi"),
                                },
                            },
                        },
                    },
                },
            },
        },
    }, pulumi.Provider(k8sProvider))
    if err != nil {
        return err
    }

    // Create service
    _, err = corev1.NewService(ctx, projectName, &corev1.ServiceArgs{
        Metadata: &metav1.ObjectMetaArgs{
            Name:      pulumi.String(projectName),
            Namespace: ns.Metadata.Name(),
        },
        Spec: &corev1.ServiceSpecArgs{
            Selector: labels,
            Ports: corev1.ServicePortArray{
                &corev1.ServicePortArgs{
                    Port:       pulumi.Int(80),
                    TargetPort: pulumi.Int(8080),
                },
            },
            Type: pulumi.String("LoadBalancer"),
        },
    }, pulumi.Provider(k8sProvider))
    if err != nil {
        return err
    }

    return nil
}
```

---

### Junior → FAANG: Pulumi with Go as the Natural Fit for Go Teams

Pulumi's key advantage for Go teams: infrastructure code is real Go code. You can use loops to create multiple resources with consistent configuration, conditions to create resources conditionally based on environment, functions to extract common patterns, and Go's type system to catch configuration errors at compile time. This eliminates the HCL constraint that requires workarounds (count, for_each) for dynamic resource creation.

The Pulumi state management model mirrors Terraform: a state backend (Pulumi Cloud, S3, or local) tracks the mapping between declared resources and actual cloud resources. The same state protection principles apply: use a remote backend, enable versioning, use stack names to separate environments.

First-job habit: use `pulumi preview` before every `pulumi up`, the same way you use `terraform plan` before `terraform apply`. The preview output shows exactly what Pulumi will create, update, or delete. The `--diff` flag on preview shows the specific property changes for updated resources, which is more informative than Terraform's plan for complex updates.

### Senior @ FAANG: Pulumi Architecture and Testing Infrastructure Code

At staff level, Pulumi's Go integration enables a testing discipline that HCL-based tools cannot match: unit testing infrastructure code with Go's standard testing framework. Pulumi's `github.com/pulumi/pulumi/sdk/v3/go/pulumi/testing` package provides mock resource implementations that enable unit tests of Pulumi programs without provisioning real cloud resources.

The testing strategy for Pulumi at scale: unit tests for module logic (does the module create the expected resources with the expected configuration?), integration tests using Pulumi's automation API (provision real resources in a test cloud account, verify behavior, destroy), and policy tests using CrossGuard (Pulumi's policy-as-code framework, analogous to OPA for Terraform). Each layer catches different classes of issues and provides different confidence levels.

The automation API is the Pulumi capability that enables programmatic infrastructure management: triggering stack updates from Go code (not just the CLI), reading stack outputs for integration tests, and building self-service infrastructure platforms where engineers request infrastructure through a service API rather than running Pulumi directly. This is the pattern that FAANG-scale platforms use to provide self-service infrastructure without giving every engineer direct cloud access.
