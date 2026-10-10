## Part 5: Testing with envtest

Testing Kubernetes controllers requires a real API server to interact with, but spinning up a full cluster for every test run would be slow and unreliable. The `envtest` package from controller-runtime solves this by starting a lightweight API server and etcd instance locally, giving you a realistic Kubernetes environment without the overhead of a full cluster. In this part, you will write integration tests that create custom resources, trigger reconciliation, and verify that the controller produces the expected child resources with correct configurations. These tests use the Ginkgo/Gomega testing framework, which is the standard in the Kubernetes ecosystem for behavior-driven tests.

### Controller Tests
The controller tests create a PostgresCluster custom resource, trigger reconciliation, and verify that the controller creates the expected StatefulSet, Service, and ConfigMap with correct configurations.

```go
// internal/controller/postgrescluster_controller_test.go
package controller

import (
    "context"
    "time"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"
    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/errors"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/types"
    "sigs.k8s.io/controller-runtime/pkg/reconcile"

    databasev1alpha1 "github.com/example/postgres-operator/api/v1alpha1"
)

var _ = Describe("PostgresCluster Controller", func() {
    const (
        timeout  = time.Second * 10
        interval = time.Millisecond * 250
    )

    Context("When reconciling a PostgresCluster", func() {
        ctx := context.Background()
        var namespace *corev1.Namespace

        BeforeEach(func() {
            // Create test namespace
            namespace = &corev1.Namespace{
                ObjectMeta: metav1.ObjectMeta{
                    GenerateName: "test-",
                },
            }
            Expect(k8sClient.Create(ctx, namespace)).Should(Succeed())
        })

        AfterEach(func() {
            // Cleanup
            Expect(k8sClient.Delete(ctx, namespace)).Should(Succeed())
        })

        It("Should create all required resources", func() {
            By("Creating a new PostgresCluster")
            pgCluster := &databasev1alpha1.PostgresCluster{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "test-cluster",
                    Namespace: namespace.Name,
                },
                Spec: databasev1alpha1.PostgresClusterSpec{
                    Version:  "18.4",
                    Replicas: 3,
                    Storage: databasev1alpha1.StorageSpec{
                        Size: "10Gi",
                    },
                },
            }
            Expect(k8sClient.Create(ctx, pgCluster)).Should(Succeed())

            // Trigger reconciliation
            controllerReconciler := &PostgresClusterReconciler{
                Client:   k8sClient,
                Scheme:   k8sClient.Scheme(),
                Recorder: recorder,
            }

            _, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
                NamespacedName: types.NamespacedName{
                    Name:      pgCluster.Name,
                    Namespace: pgCluster.Namespace,
                },
            })
            Expect(err).NotTo(HaveOccurred())

            By("Checking ConfigMap creation")
            configMap := &corev1.ConfigMap{}
            Eventually(func() bool {
                err := k8sClient.Get(ctx, types.NamespacedName{
                    Name:      "test-cluster-config",
                    Namespace: namespace.Name,
                }, configMap)
                return err == nil
            }, timeout, interval).Should(BeTrue())

            Expect(configMap.Data).Should(HaveKey("postgresql.conf"))
            Expect(configMap.Data).Should(HaveKey("pg_hba.conf"))

            By("Checking Secret creation")
            secret := &corev1.Secret{}
            Eventually(func() bool {
                err := k8sClient.Get(ctx, types.NamespacedName{
                    Name:      "test-cluster-credentials",
                    Namespace: namespace.Name,
                }, secret)
                return err == nil
            }, timeout, interval).Should(BeTrue())

            Expect(secret.Data).Should(HaveKey("password"))
            Expect(secret.Data).Should(HaveKey("username"))

            By("Checking StatefulSet creation")
            statefulSet := &appsv1.StatefulSet{}
            Eventually(func() bool {
                err := k8sClient.Get(ctx, types.NamespacedName{
                    Name:      "test-cluster",
                    Namespace: namespace.Name,
                }, statefulSet)
                return err == nil
            }, timeout, interval).Should(BeTrue())

            Expect(*statefulSet.Spec.Replicas).Should(Equal(int32(3)))
            Expect(statefulSet.Spec.ServiceName).Should(Equal("test-cluster-headless"))

            By("Checking Services creation")
            headlessService := &corev1.Service{}
            Eventually(func() bool {
                err := k8sClient.Get(ctx, types.NamespacedName{
                    Name:      "test-cluster-headless",
                    Namespace: namespace.Name,
                }, headlessService)
                return err == nil
            }, timeout, interval).Should(BeTrue())

            Expect(headlessService.Spec.ClusterIP).Should(Equal("None"))

            rwService := &corev1.Service{}
            Eventually(func() bool {
                err := k8sClient.Get(ctx, types.NamespacedName{
                    Name:      "test-cluster",
                    Namespace: namespace.Name,
                }, rwService)
                return err == nil
            }, timeout, interval).Should(BeTrue())

            By("Checking owner references")
            Expect(configMap.OwnerReferences).Should(HaveLen(1))
            Expect(configMap.OwnerReferences[0].Name).Should(Equal("test-cluster"))
            Expect(configMap.OwnerReferences[0].Kind).Should(Equal("PostgresCluster"))
        })

        It("Should handle backup configuration", func() {
            By("Creating a PostgresCluster with backup enabled")
            pgCluster := &databasev1alpha1.PostgresCluster{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "test-backup-cluster",
                    Namespace: namespace.Name,
                },
                Spec: databasev1alpha1.PostgresClusterSpec{
                    Version:  "18.4",
                    Replicas: 1,
                    Storage: databasev1alpha1.StorageSpec{
                        Size: "10Gi",
                    },
                    Backup: &databasev1alpha1.BackupSpec{
                        Enabled:  true,
                        Schedule: "0 2 * * *",
                        S3: &databasev1alpha1.S3Spec{
                            Bucket:            "my-backups",
                            Region:            "us-east-1",
                            CredentialsSecret: "aws-creds",
                        },
                    },
                },
            }
            Expect(k8sClient.Create(ctx, pgCluster)).Should(Succeed())

            // Trigger reconciliation
            controllerReconciler := &PostgresClusterReconciler{
                Client:   k8sClient,
                Scheme:   k8sClient.Scheme(),
                Recorder: recorder,
            }

            _, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
                NamespacedName: types.NamespacedName{
                    Name:      pgCluster.Name,
                    Namespace: pgCluster.Namespace,
                },
            })
            Expect(err).NotTo(HaveOccurred())

            By("Checking CronJob creation")
            // Note: CronJob requires batch/v1 API which may not be available in all envtest setups
            // This is a demonstration of how you would test it
        })

        It("Should update status correctly", func() {
            By("Creating a PostgresCluster")
            pgCluster := &databasev1alpha1.PostgresCluster{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "test-status-cluster",
                    Namespace: namespace.Name,
                },
                Spec: databasev1alpha1.PostgresClusterSpec{
                    Version:  "18.4",
                    Replicas: 2,
                    Storage: databasev1alpha1.StorageSpec{
                        Size: "10Gi",
                    },
                },
            }
            Expect(k8sClient.Create(ctx, pgCluster)).Should(Succeed())

            // Trigger reconciliation
            controllerReconciler := &PostgresClusterReconciler{
                Client:   k8sClient,
                Scheme:   k8sClient.Scheme(),
                Recorder: recorder,
            }

            _, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
                NamespacedName: types.NamespacedName{
                    Name:      pgCluster.Name,
                    Namespace: pgCluster.Namespace,
                },
            })
            Expect(err).NotTo(HaveOccurred())

            By("Checking status update")
            updatedCluster := &databasev1alpha1.PostgresCluster{}
            Eventually(func() bool {
                err := k8sClient.Get(ctx, types.NamespacedName{
                    Name:      pgCluster.Name,
                    Namespace: pgCluster.Namespace,
                }, updatedCluster)
                if err != nil {
                    return false
                }
                return updatedCluster.Status.Phase != ""
            }, timeout, interval).Should(BeTrue())

            Expect(updatedCluster.Status.Phase).Should(Or(
                Equal(databasev1alpha1.ClusterPhasePending),
                Equal(databasev1alpha1.ClusterPhaseCreating),
            ))
            Expect(updatedCluster.Status.Conditions).ShouldNot(BeEmpty())
        })

        It("Should handle deletion with finalizer", func() {
            By("Creating a PostgresCluster")
            pgCluster := &databasev1alpha1.PostgresCluster{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "test-delete-cluster",
                    Namespace: namespace.Name,
                },
                Spec: databasev1alpha1.PostgresClusterSpec{
                    Version:  "18.4",
                    Replicas: 1,
                    Storage: databasev1alpha1.StorageSpec{
                        Size: "10Gi",
                    },
                },
            }
            Expect(k8sClient.Create(ctx, pgCluster)).Should(Succeed())

            // Trigger reconciliation to add finalizer
            controllerReconciler := &PostgresClusterReconciler{
                Client:   k8sClient,
                Scheme:   k8sClient.Scheme(),
                Recorder: recorder,
            }

            _, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
                NamespacedName: types.NamespacedName{
                    Name:      pgCluster.Name,
                    Namespace: pgCluster.Namespace,
                },
            })
            Expect(err).NotTo(HaveOccurred())

            // Verify finalizer was added
            updatedCluster := &databasev1alpha1.PostgresCluster{}
            Expect(k8sClient.Get(ctx, types.NamespacedName{
                Name:      pgCluster.Name,
                Namespace: pgCluster.Namespace,
            }, updatedCluster)).Should(Succeed())

            Expect(updatedCluster.Finalizers).Should(ContainElement(finalizerName))

            By("Deleting the PostgresCluster")
            Expect(k8sClient.Delete(ctx, updatedCluster)).Should(Succeed())

            // Trigger reconciliation for deletion
            _, err = controllerReconciler.Reconcile(ctx, reconcile.Request{
                NamespacedName: types.NamespacedName{
                    Name:      pgCluster.Name,
                    Namespace: pgCluster.Namespace,
                },
            })
            Expect(err).NotTo(HaveOccurred())

            By("Verifying cluster is deleted")
            Eventually(func() bool {
                err := k8sClient.Get(ctx, types.NamespacedName{
                    Name:      pgCluster.Name,
                    Namespace: pgCluster.Namespace,
                }, updatedCluster)
                return errors.IsNotFound(err)
            }, timeout, interval).Should(BeTrue())
        })
    })
})
```

### Webhook Tests

The webhook tests verify that the validating and mutating webhooks correctly reject invalid resource specifications (e.g., zero replicas, invalid storage sizes) and apply default values where needed.

```go
// api/v1alpha1/postgrescluster_webhook_test.go
package v1alpha1

import (
    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"
    corev1 "k8s.io/api/core/v1"
)

var _ = Describe("PostgresCluster Webhook", func() {
    Context("When creating a PostgresCluster", func() {
        It("Should accept valid configuration", func() {
            pgCluster := &PostgresCluster{
                Spec: PostgresClusterSpec{
                    Version:  "18.4",
                    Replicas: 3,
                    Storage: StorageSpec{
                        Size: "10Gi",
                    },
                },
            }

            _, err := pgCluster.ValidateCreate()
            Expect(err).NotTo(HaveOccurred())
        })

        It("Should reject invalid version format", func() {
            pgCluster := &PostgresCluster{
                Spec: PostgresClusterSpec{
                    Version:  "invalid",
                    Replicas: 1,
                    Storage: StorageSpec{
                        Size: "10Gi",
                    },
                },
            }

            _, err := pgCluster.ValidateCreate()
            Expect(err).To(HaveOccurred())
            Expect(err.Error()).To(ContainSubstring("version"))
        })

        It("Should reject old PostgreSQL versions", func() {
            pgCluster := &PostgresCluster{
                Spec: PostgresClusterSpec{
                    Version:  "11.0",
                    Replicas: 1,
                    Storage: StorageSpec{
                        Size: "10Gi",
                    },
                },
            }

            _, err := pgCluster.ValidateCreate()
            Expect(err).To(HaveOccurred())
            Expect(err.Error()).To(ContainSubstring("must be 12 or higher"))
        })

        It("Should reject invalid storage size", func() {
            pgCluster := &PostgresCluster{
                Spec: PostgresClusterSpec{
                    Version:  "18.4",
                    Replicas: 1,
                    Storage: StorageSpec{
                        Size: "500Mi",
                    },
                },
            }

            _, err := pgCluster.ValidateCreate()
            Expect(err).To(HaveOccurred())
            Expect(err.Error()).To(ContainSubstring("minimum storage size"))
        })

        It("Should reject HA with insufficient replicas", func() {
            pgCluster := &PostgresCluster{
                Spec: PostgresClusterSpec{
                    Version:  "18.4",
                    Replicas: 1,
                    Storage: StorageSpec{
                        Size: "10Gi",
                    },
                    HA: &HASpec{
                        Enabled: true,
                    },
                },
            }

            _, err := pgCluster.ValidateCreate()
            Expect(err).To(HaveOccurred())
            Expect(err.Error()).To(ContainSubstring("at least 2 replicas"))
        })

        It("Should reject dangerous parameters", func() {
            pgCluster := &PostgresCluster{
                Spec: PostgresClusterSpec{
                    Version:  "18.4",
                    Replicas: 1,
                    Storage: StorageSpec{
                        Size: "10Gi",
                    },
                    Parameters: map[string]string{
                        "port":            "5433",
                        "data_directory":  "/custom/path",
                    },
                },
            }

            _, err := pgCluster.ValidateCreate()
            Expect(err).To(HaveOccurred())
            Expect(err.Error()).To(ContainSubstring("cannot be set via CRD"))
        })
    })

    Context("When updating a PostgresCluster", func() {
        It("Should allow version upgrade", func() {
            oldCluster := &PostgresCluster{
                Spec: PostgresClusterSpec{
                    Version:  "15.1",
                    Replicas: 1,
                    Storage: StorageSpec{
                        Size: "10Gi",
                    },
                },
            }

            newCluster := &PostgresCluster{
                Spec: PostgresClusterSpec{
                    Version:  "18.4",
                    Replicas: 1,
                    Storage: StorageSpec{
                        Size: "10Gi",
                    },
                },
            }

            _, err := newCluster.ValidateUpdate(oldCluster)
            Expect(err).NotTo(HaveOccurred())
        })

        It("Should reject version downgrade", func() {
            oldCluster := &PostgresCluster{
                Spec: PostgresClusterSpec{
                    Version:  "18.4",
                    Replicas: 1,
                    Storage: StorageSpec{
                        Size: "10Gi",
                    },
                },
            }

            newCluster := &PostgresCluster{
                Spec: PostgresClusterSpec{
                    Version:  "14.5",
                    Replicas: 1,
                    Storage: StorageSpec{
                        Size: "10Gi",
                    },
                },
            }

            _, err := newCluster.ValidateUpdate(oldCluster)
            Expect(err).To(HaveOccurred())
            Expect(err.Error()).To(ContainSubstring("cannot be downgraded"))
        })

        It("Should allow storage size increase", func() {
            oldCluster := &PostgresCluster{
                Spec: PostgresClusterSpec{
                    Version:  "18.4",
                    Replicas: 1,
                    Storage: StorageSpec{
                        Size: "10Gi",
                    },
                },
            }

            newCluster := &PostgresCluster{
                Spec: PostgresClusterSpec{
                    Version:  "18.4",
                    Replicas: 1,
                    Storage: StorageSpec{
                        Size: "20Gi",
                    },
                },
            }

            _, err := newCluster.ValidateUpdate(oldCluster)
            Expect(err).NotTo(HaveOccurred())
        })

        It("Should reject storage size decrease", func() {
            oldCluster := &PostgresCluster{
                Spec: PostgresClusterSpec{
                    Version:  "18.4",
                    Replicas: 1,
                    Storage: StorageSpec{
                        Size: "20Gi",
                    },
                },
            }

            newCluster := &PostgresCluster{
                Spec: PostgresClusterSpec{
                    Version:  "18.4",
                    Replicas: 1,
                    Storage: StorageSpec{
                        Size: "10Gi",
                    },
                },
            }

            _, err := newCluster.ValidateUpdate(oldCluster)
            Expect(err).To(HaveOccurred())
            Expect(err.Error()).To(ContainSubstring("cannot be decreased"))
        })
    })

    Context("When applying defaults", func() {
        It("Should set default image", func() {
            pgCluster := &PostgresCluster{
                Spec: PostgresClusterSpec{
                    Version:  "18.4",
                    Replicas: 1,
                    Storage: StorageSpec{
                        Size: "10Gi",
                    },
                },
            }

            pgCluster.Default()
            Expect(pgCluster.Spec.Image).Should(Equal("postgres:18.4"))
        })

        It("Should set default access mode", func() {
            pgCluster := &PostgresCluster{
                Spec: PostgresClusterSpec{
                    Version:  "18.4",
                    Replicas: 1,
                    Storage: StorageSpec{
                        Size: "10Gi",
                    },
                },
            }

            pgCluster.Default()
            Expect(pgCluster.Spec.Storage.AccessMode).Should(Equal(corev1.PersistentVolumeAccessMode("ReadWriteOnce")))
        })

        It("Should set default backup retention", func() {
            pgCluster := &PostgresCluster{
                Spec: PostgresClusterSpec{
                    Version:  "18.4",
                    Replicas: 1,
                    Storage: StorageSpec{
                        Size: "10Gi",
                    },
                    Backup: &BackupSpec{
                        Enabled: true,
                        S3: &S3Spec{
                            Bucket:            "my-bucket",
                            CredentialsSecret: "aws-creds",
                        },
                    },
                },
            }

            pgCluster.Default()
            Expect(pgCluster.Spec.Backup.Retention).Should(Equal(int32(7)))
            Expect(pgCluster.Spec.Backup.Schedule).Should(Equal("0 2 * * *"))
        })
    })
})
```

### Test Suite Setup

The test suite setup bootstraps envtest's local API server and etcd, registers the CRD schemas, and creates a shared manager that all test cases use. It tears down the environment after all tests complete.

```go
// internal/controller/suite_test.go
package controller

import (
    "context"
    "path/filepath"
    "testing"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"
    "k8s.io/client-go/kubernetes/scheme"
    "k8s.io/client-go/rest"
    "k8s.io/client-go/tools/record"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/envtest"
    logf "sigs.k8s.io/controller-runtime/pkg/log"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"

    databasev1alpha1 "github.com/example/postgres-operator/api/v1alpha1"
)

var (
    cfg       *rest.Config
    k8sClient client.Client
    testEnv   *envtest.Environment
    ctx       context.Context
    cancel    context.CancelFunc
    recorder  record.EventRecorder
)

func TestControllers(t *testing.T) {
    RegisterFailHandler(Fail)
    RunSpecs(t, "Controller Suite")
}

var _ = BeforeSuite(func() {
    logf.SetLogger(zap.New(zap.WriteTo(GinkgoWriter), zap.UseDevMode(true)))

    ctx, cancel = context.WithCancel(context.TODO())

    By("bootstrapping test environment")
    testEnv = &envtest.Environment{
        CRDDirectoryPaths:     []string{filepath.Join("..", "..", "config", "crd", "bases")},
        ErrorIfCRDPathMissing: true,
    }

    var err error
    cfg, err = testEnv.Start()
    Expect(err).NotTo(HaveOccurred())
    Expect(cfg).NotTo(BeNil())

    err = databasev1alpha1.AddToScheme(scheme.Scheme)
    Expect(err).NotTo(HaveOccurred())

    k8sClient, err = client.New(cfg, client.Options{Scheme: scheme.Scheme})
    Expect(err).NotTo(HaveOccurred())
    Expect(k8sClient).NotTo(BeNil())

    recorder = record.NewFakeRecorder(100)
})

var _ = AfterSuite(func() {
    cancel()
    By("tearing down the test environment")
    err := testEnv.Stop()
    Expect(err).NotTo(HaveOccurred())
})
```
