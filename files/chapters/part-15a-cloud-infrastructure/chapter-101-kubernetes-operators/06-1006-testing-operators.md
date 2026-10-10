## 101.6 Testing Operators

### Unit Tests

Operator unit tests use the Ginkgo/Gomega BDD framework paired with a real `client.Client` backed by `envtest`, an in-process Kubernetes API server. This lets you exercise the full reconciliation loop (create → watch → reconcile → status update) without a real cluster, catching ownership, label selector, and status-subresource bugs that pure mock-based tests miss. The `Eventually` polling pattern is essential because reconciliation is asynchronous. The assertion retries until the expected state appears or the timeout expires.

```go
// controllers/webapp_controller_test.go
package controllers

import (
    "context"
    "time"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"

    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/types"

    appsv1alpha1 "github.com/example/webapp-operator/api/v1alpha1"
)

var _ = Describe("WebApp Controller", func() {
    const (
        timeout  = time.Second * 10
        interval = time.Millisecond * 250
    )

    Context("When creating a WebApp", func() {
        It("Should create a Deployment and Service", func() {
            ctx := context.Background()

            webapp := &appsv1alpha1.WebApp{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "test-webapp",
                    Namespace: "default",
                },
                Spec: appsv1alpha1.WebAppSpec{
                    Image:    "nginx:latest",
                    Replicas: 2,
                    Port:     8080,
                },
            }

            Expect(k8sClient.Create(ctx, webapp)).Should(Succeed())

            // Check Deployment is created
            deploymentLookupKey := types.NamespacedName{Name: "test-webapp", Namespace: "default"}
            createdDeployment := &appsv1.Deployment{}

            Eventually(func() bool {
                err := k8sClient.Get(ctx, deploymentLookupKey, createdDeployment)
                return err == nil
            }, timeout, interval).Should(BeTrue())

            Expect(*createdDeployment.Spec.Replicas).Should(Equal(int32(2)))
            Expect(createdDeployment.Spec.Template.Spec.Containers[0].Image).Should(Equal("nginx:latest"))

            // Check Service is created
            serviceLookupKey := types.NamespacedName{Name: "test-webapp", Namespace: "default"}
            createdService := &corev1.Service{}

            Eventually(func() bool {
                err := k8sClient.Get(ctx, serviceLookupKey, createdService)
                return err == nil
            }, timeout, interval).Should(BeTrue())

            Expect(createdService.Spec.Ports[0].Port).Should(Equal(int32(80)))
        })
    })

    Context("When updating a WebApp", func() {
        It("Should update the Deployment", func() {
            ctx := context.Background()

            // Get existing WebApp
            webapp := &appsv1alpha1.WebApp{}
            Expect(k8sClient.Get(ctx, types.NamespacedName{
                Name:      "test-webapp",
                Namespace: "default",
            }, webapp)).Should(Succeed())

            // Update replicas
            webapp.Spec.Replicas = 3
            Expect(k8sClient.Update(ctx, webapp)).Should(Succeed())

            // Verify Deployment is updated
            deployment := &appsv1.Deployment{}
            Eventually(func() int32 {
                k8sClient.Get(ctx, types.NamespacedName{
                    Name:      "test-webapp",
                    Namespace: "default",
                }, deployment)
                return *deployment.Spec.Replicas
            }, timeout, interval).Should(Equal(int32(3)))
        })
    })

    Context("When deleting a WebApp", func() {
        It("Should delete owned resources", func() {
            ctx := context.Background()

            // Delete WebApp
            webapp := &appsv1alpha1.WebApp{}
            Expect(k8sClient.Get(ctx, types.NamespacedName{
                Name:      "test-webapp",
                Namespace: "default",
            }, webapp)).Should(Succeed())

            Expect(k8sClient.Delete(ctx, webapp)).Should(Succeed())

            // Verify Deployment is deleted
            deployment := &appsv1.Deployment{}
            Eventually(func() bool {
                err := k8sClient.Get(ctx, types.NamespacedName{
                    Name:      "test-webapp",
                    Namespace: "default",
                }, deployment)
                return err != nil
            }, timeout, interval).Should(BeTrue())
        })
    })
})
```

### Integration Tests with envtest

`envtest` starts a real `kube-apiserver` and `etcd` binary in-process, loads your CRD manifests from disk, and registers your reconciler against the manager, giving you a faithful integration environment without Docker or a real cluster. The `BeforeSuite` / `AfterSuite` hooks manage the lifecycle: the manager runs in a goroutine driven by a cancellable context so that `AfterSuite` can cleanly drain in-flight reconciliations before stopping the API server and avoiding data-race false positives in the test binary.

```go
// controllers/suite_test.go
package controllers

import (
    "context"
    "path/filepath"
    "testing"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"

    "k8s.io/client-go/kubernetes/scheme"
    "k8s.io/client-go/rest"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/envtest"
    logf "sigs.k8s.io/controller-runtime/pkg/log"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"

    appsv1alpha1 "github.com/example/webapp-operator/api/v1alpha1"
)

var cfg *rest.Config
var k8sClient client.Client
var testEnv *envtest.Environment
var ctx context.Context
var cancel context.CancelFunc

func TestControllers(t *testing.T) {
    RegisterFailHandler(Fail)
    RunSpecs(t, "Controller Suite")
}

var _ = BeforeSuite(func() {
    logf.SetLogger(zap.New(zap.WriteTo(GinkgoWriter), zap.UseDevMode(true)))

    ctx, cancel = context.WithCancel(context.TODO())

    By("bootstrapping test environment")
    testEnv = &envtest.Environment{
        CRDDirectoryPaths:     []string{filepath.Join("..", "config", "crd", "bases")},
        ErrorIfCRDPathMissing: true,
    }

    var err error
    cfg, err = testEnv.Start()
    Expect(err).NotTo(HaveOccurred())
    Expect(cfg).NotTo(BeNil())

    err = appsv1alpha1.AddToScheme(scheme.Scheme)
    Expect(err).NotTo(HaveOccurred())

    k8sClient, err = client.New(cfg, client.Options{Scheme: scheme.Scheme})
    Expect(err).NotTo(HaveOccurred())
    Expect(k8sClient).NotTo(BeNil())

    // Start controller
    k8sManager, err := ctrl.NewManager(cfg, ctrl.Options{
        Scheme: scheme.Scheme,
    })
    Expect(err).ToNot(HaveOccurred())

    err = (&WebAppReconciler{
        Client: k8sManager.GetClient(),
        Scheme: k8sManager.GetScheme(),
    }).SetupWithManager(k8sManager)
    Expect(err).ToNot(HaveOccurred())

    go func() {
        defer GinkgoRecover()
        err = k8sManager.Start(ctx)
        Expect(err).ToNot(HaveOccurred())
    }()
})

var _ = AfterSuite(func() {
    cancel()
    By("tearing down the test environment")
    err := testEnv.Stop()
    Expect(err).NotTo(HaveOccurred())
})
```

---

### Junior → FAANG: Operator Testing Is Non-Negotiable

Operator testing requires a different approach than typical Go unit tests because the reconcile function interacts with a Kubernetes API server. The fake client from `sigs.k8s.io/controller-runtime/pkg/client/fake` is sufficient for unit tests of reconcile logic that does not require admission webhooks or status subresource updates. For anything more complex, `envtest` is required.

The fake client's limitations: it does not enforce webhook validation, it does not apply defaulting, it does not enforce field immutability, and it does not model list semantic subtleties. These limitations are acceptable for unit tests of core reconcile logic. For testing the integration between the operator and the Kubernetes API (including all admission and status behavior), `envtest` is the correct tool.

First-job habit: write tests that cover the three most important operator scenarios: create (resource is created for the first time), update (resource spec changes), and delete (resource is deleted and cleanup occurs). These three scenarios cover the majority of real-world operator behavior.

### Senior @ FAANG: Operator Testing Strategy and CI Infrastructure

At staff level, the operator testing strategy has three layers: unit tests with the fake client for rapid feedback on reconcile logic, integration tests with envtest for API behavior, and e2e tests against a real cluster (kind in CI) for end-to-end validation including CRD installation and multi-controller interaction.

The envtest environment needs to be configured with the CRDs under test. The Kubebuilder controller test framework provides helpers for this. The integration test suite should cover: the happy path (resource created successfully, all sub-resources created correctly), the error path (external dependency unavailable, partial resource creation), the concurrent reconcile path (multiple resources changed simultaneously), and the upgrade path (old version of the CRD is present, new version of the controller is started).

E2e tests against a kind cluster in CI are slow (3-5 minutes to start the cluster, install CRDs, deploy the operator, run tests) but provide the highest confidence. They should be run on every PR but can be parallelized across multiple kind clusters to keep the total CI time acceptable. The CI infrastructure for operator e2e tests is a meaningful platform investment that benefits every team building operators in the organization.
