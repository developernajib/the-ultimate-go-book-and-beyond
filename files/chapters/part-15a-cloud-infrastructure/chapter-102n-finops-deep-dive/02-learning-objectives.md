## Learning Objectives

By the end of this chapter, you will:
- Understand the core FinOps principles - visibility, optimization, and operational integration - and how they apply to engineering decisions in Go service design and infrastructure provisioning
- Be able to implement cloud cost attribution using resource tagging strategies, account-level separation, and the AWS Cost Explorer / GCP Billing APIs from Go
- Know how to optimize Kubernetes workload costs through right-sizing resource requests/limits, using Vertical Pod Autoscaler, and implementing cluster bin-packing strategies
- Understand unit economics for cloud services - computing cost-per-request, cost-per-user, and cost-per-transaction - and instrumenting Go services to expose these metrics
- Be able to design and enforce a tagging governance system that ensures consistent cost attribution tags across all cloud resources using policy-as-code tools
- Know how to implement cost forecasting models using historical billing data, trend analysis, and anomaly detection to predict and alert on unexpected spend
- Understand the difference between showback (informational cost reporting to teams) and chargeback (actual internal billing), and implement both models using Go-based reporting pipelines
- Be able to evaluate and integrate FinOps tooling such as Kubecost, Infracost, OpenCost, and cloud-native cost dashboards into engineering and finance workflows

---

### Junior → FAANG: Learning Objectives as a FinOps Interview Preparation Map

The objectives in this section map directly to the FinOps topics that appear in senior and staff engineering interviews at FAANG and cloud-native companies. "Implement cost allocation pipelines" signals that you can build the infrastructure, not just consume it. "Design cost-aware Go services" signals that you think about cost as a design constraint, not an afterthought. "Implement cost forecasting models" signals that you can work with time-series data and statistical models, which is a differentiating skill for infrastructure engineers.

The showback vs. chargeback objective is one that many engineers can define but few can implement. Practice implementing a simple showback system: take Cost Explorer data for a month, allocate shared costs using a proportional usage model, and produce a per-team cost report. The implementation reveals the hard parts (tagging gaps, shared resource allocation, data normalization) that the definition does not.

### Senior @ FAANG: Learning Objectives as Team Competency Baseline

At staff level, these objectives define the minimum competency for engineers contributing to cloud platform or infrastructure work. An engineer who cannot explain unit economics cannot participate meaningfully in capacity planning discussions. An engineer who cannot read Cost Explorer data cannot own their service's cost efficiency.

The FinOps tooling objective (Kubecost, Infracost, OpenCost) is particularly important for platform teams: these tools have different integration models, different cost model accuracy, and different organizational adoption requirements. Kubecost requires cluster-level access and uses a proprietary cost model that can be configured with cloud billing data. OpenCost is the CNCF-incubated open standard that provides a consistent API regardless of the underlying cost model. Infracost integrates into the IaC workflow and provides per-PR cost impact estimates. A platform team that evaluates these tools rigorously and selects one as the organizational standard for Kubernetes cost attribution is more efficient than ten teams independently evaluating the same tools and reaching different conclusions. That evaluation and selection is a staff engineer deliverable.
