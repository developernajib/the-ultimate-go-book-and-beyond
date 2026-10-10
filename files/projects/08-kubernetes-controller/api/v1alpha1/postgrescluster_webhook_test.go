package v1alpha1

import (
	"testing"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestPostgresCluster_Default(t *testing.T) {
	cluster := &PostgresCluster{
		ObjectMeta: metav1.ObjectMeta{
			Name: "test-cluster",
		},
		Spec: PostgresClusterSpec{
			Version: "16.0",
			Backup: &BackupSpec{
				Enabled: true,
			},
			HA: &HASpec{
				Enabled: true,
			},
		},
	}

	cluster.Default()

	if cluster.Spec.Image != "postgres:16.0" {
		t.Errorf("expected default image postgres:16.0, got %s", cluster.Spec.Image)
	}
	if cluster.Spec.Replicas != 1 {
		t.Errorf("expected default replicas 1, got %d", cluster.Spec.Replicas)
	}
	if cluster.Spec.Storage.AccessMode != "ReadWriteOnce" {
		t.Errorf("expected default access mode ReadWriteOnce, got %s", cluster.Spec.Storage.AccessMode)
	}
	if cluster.Spec.Backup.Retention != 7 {
		t.Errorf("expected default backup retention 7, got %d", cluster.Spec.Backup.Retention)
	}
	if cluster.Spec.HA.ReplicationMode != "async" {
		t.Errorf("expected default replication mode async, got %s", cluster.Spec.HA.ReplicationMode)
	}
}

func TestPostgresCluster_ValidateCreate(t *testing.T) {
	validCluster := &PostgresCluster{
		ObjectMeta: metav1.ObjectMeta{
			Name: "valid-cluster",
		},
		Spec: PostgresClusterSpec{
			Version: "16.0",
			Storage: StorageSpec{
				Size: "10Gi",
			},
		},
	}

	_, err := validCluster.ValidateCreate()
	if err != nil {
		t.Fatalf("expected valid cluster to pass validation: %v", err)
	}

	invalidCluster := &PostgresCluster{
		ObjectMeta: metav1.ObjectMeta{
			Name: "invalid-cluster",
		},
		Spec: PostgresClusterSpec{
			Version: "invalid-version-string",
			Storage: StorageSpec{
				Size: "invalid-size",
			},
		},
	}

	_, err = invalidCluster.ValidateCreate()
	if err == nil {
		t.Fatalf("expected invalid cluster to fail validation")
	}
}
