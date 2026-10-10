## Part 8: REST API and gRPC Interfaces

Your ML platform needs to be accessible to both human users and other services. REST APIs are ideal for human-facing tools like dashboards and CLIs because they are easy to call from any language and work well with browsers. gRPC is better suited for service-to-service communication, especially for the model serving path where low latency and high throughput matter. In this part, you will build both interfaces so your platform can serve a wide range of clients.

### 8.1 REST API Handlers

These handlers expose the platform's core functionality over HTTP using the Gorilla Mux router. Each handler follows a consistent pattern: parse the request, validate inputs, call the appropriate service method, and return a JSON response with proper status codes. Error responses include meaningful messages to help callers diagnose problems. The handlers cover experiment management, run tracking, model registry operations, and prediction serving.

```go
// internal/api/http/handlers.go
package http

import (
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
	"github.com/gorilla/mux"
	"ml-platform/internal/service/experiment"
	"ml-platform/internal/service/registry"
	"ml-platform/internal/service/serving"
	"ml-platform/internal/service/featurestore"
)

// Server handles HTTP requests
type Server struct {
	experimentService   *experiment.Service
	registryService     *registry.Service
	servingService      *serving.Service
	featureStoreService *featurestore.Service
	router              *mux.Router
}

// NewServer creates a new HTTP server
func NewServer(
	experimentService *experiment.Service,
	registryService *registry.Service,
	servingService *serving.Service,
	featureStoreService *featurestore.Service,
) *Server {
	s := &Server{
		experimentService:   experimentService,
		registryService:     registryService,
		servingService:      servingService,
		featureStoreService: featureStoreService,
		router:              mux.NewRouter(),
	}

	s.setupRoutes()
	return s
}

func (s *Server) setupRoutes() {
	// Experiment tracking endpoints
	s.router.HandleFunc("/api/v1/experiments", s.createExperiment).Methods("POST")
	s.router.HandleFunc("/api/v1/experiments/{id}", s.getExperiment).Methods("GET")
	s.router.HandleFunc("/api/v1/experiments", s.listExperiments).Methods("GET")
	
	s.router.HandleFunc("/api/v1/runs", s.createRun).Methods("POST")
	s.router.HandleFunc("/api/v1/runs/{id}", s.getRun).Methods("GET")
	s.router.HandleFunc("/api/v1/runs/{id}/metrics", s.logMetric).Methods("POST")
	s.router.HandleFunc("/api/v1/runs/{id}/artifacts", s.logArtifact).Methods("POST")
	s.router.HandleFunc("/api/v1/runs/{id}/finish", s.finishRun).Methods("POST")

	// Model registry endpoints
	s.router.HandleFunc("/api/v1/models", s.registerModel).Methods("POST")
	s.router.HandleFunc("/api/v1/models/{name}", s.getModel).Methods("GET")
	s.router.HandleFunc("/api/v1/models/{name}/versions", s.createModelVersion).Methods("POST")
	s.router.HandleFunc("/api/v1/models/{name}/versions/{version}", s.getModelVersion).Methods("GET")
	s.router.HandleFunc("/api/v1/models/versions/{id}/transition", s.transitionStage).Methods("POST")

	// Model serving endpoints
	s.router.HandleFunc("/api/v1/predict", s.predict).Methods("POST")
	s.router.HandleFunc("/api/v1/models/{name}/load", s.loadModel).Methods("POST")

	// Feature store endpoints
	s.router.HandleFunc("/api/v1/feature-groups", s.createFeatureGroup).Methods("POST")
	s.router.HandleFunc("/api/v1/feature-views", s.createFeatureView).Methods("POST")
	s.router.HandleFunc("/api/v1/features/online", s.getOnlineFeatures).Methods("POST")
	s.router.HandleFunc("/api/v1/features/offline", s.getOfflineFeatures).Methods("POST")
}

// Experiment handlers

func (s *Server) createExperiment(w http.ResponseWriter, r *http.Request) {
	var req experiment.CreateExperimentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	exp, err := s.experimentService.CreateExperiment(r.Context(), req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	respondJSON(w, http.StatusCreated, exp)
}

func (s *Server) getExperiment(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	id, err := uuid.Parse(vars["id"])
	if err != nil {
		http.Error(w, "invalid experiment ID", http.StatusBadRequest)
		return
	}

	// Implementation would call experiment service
	respondJSON(w, http.StatusOK, map[string]string{"id": id.String()})
}

func (s *Server) listExperiments(w http.ResponseWriter, r *http.Request) {
	// Parse query parameters for pagination
	// limit := r.URL.Query().Get("limit")
	// offset := r.URL.Query().Get("offset")

	// Implementation would call experiment service
	respondJSON(w, http.StatusOK, []any{})
}

func (s *Server) createRun(w http.ResponseWriter, r *http.Request) {
	var req experiment.CreateRunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	run, err := s.experimentService.CreateRun(r.Context(), req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	respondJSON(w, http.StatusCreated, run)
}

func (s *Server) getRun(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	id, err := uuid.Parse(vars["id"])
	if err != nil {
		http.Error(w, "invalid run ID", http.StatusBadRequest)
		return
	}

	// Implementation would call experiment service
	respondJSON(w, http.StatusOK, map[string]string{"id": id.String()})
}

func (s *Server) logMetric(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	runID, err := uuid.Parse(vars["id"])
	if err != nil {
		http.Error(w, "invalid run ID", http.StatusBadRequest)
		return
	}

	var req struct {
		Key   string  `json:"key"`
		Value float64 `json:"value"`
		Step  int64   `json:"step"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if err := s.experimentService.LogMetric(r.Context(), runID, req.Key, req.Value, req.Step); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "success"})
}

func (s *Server) logArtifact(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	runID, err := uuid.Parse(vars["id"])
	if err != nil {
		http.Error(w, "invalid run ID", http.StatusBadRequest)
		return
	}

	// Parse multipart form for file upload
	err = r.ParseMultipartForm(10 << 20) // 10 MB max
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	file, _, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "file is required", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// Read file data
	// Implementation would upload file and log artifact

	respondJSON(w, http.StatusOK, map[string]string{"runID": runID.String()})
}

func (s *Server) finishRun(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	runID, err := uuid.Parse(vars["id"])
	if err != nil {
		http.Error(w, "invalid run ID", http.StatusBadRequest)
		return
	}

	var req struct {
		Status string `json:"status"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Convert status string to domain.RunStatus
	// Call experiment service to finish run

	respondJSON(w, http.StatusOK, map[string]string{"status": "success"})
}

// Model registry handlers

func (s *Server) registerModel(w http.ResponseWriter, r *http.Request) {
	var req registry.RegisterModelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	model, err := s.registryService.RegisterModel(r.Context(), req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	respondJSON(w, http.StatusCreated, model)
}

func (s *Server) getModel(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	name := vars["name"]

	// Implementation would call registry service
	respondJSON(w, http.StatusOK, map[string]string{"name": name})
}

func (s *Server) createModelVersion(w http.ResponseWriter, r *http.Request) {
	var req registry.CreateModelVersionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	version, err := s.registryService.CreateModelVersion(r.Context(), req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	respondJSON(w, http.StatusCreated, version)
}

func (s *Server) getModelVersion(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	name := vars["name"]
	version := vars["version"]

	// Implementation would call registry service
	respondJSON(w, http.StatusOK, map[string]string{"name": name, "version": version})
}

func (s *Server) transitionStage(w http.ResponseWriter, r *http.Request) {
	var req registry.TransitionStageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if err := s.registryService.TransitionModelStage(r.Context(), req); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "success"})
}

// Model serving handlers

func (s *Server) predict(w http.ResponseWriter, r *http.Request) {
	var req serving.PredictRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	response, err := s.servingService.Predict(r.Context(), req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	respondJSON(w, http.StatusOK, response)
}

func (s *Server) loadModel(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	modelName := vars["name"]

	var req struct {
		Version int    `json:"version"`
		Stage   string `json:"stage"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Call serving service to load model
	respondJSON(w, http.StatusOK, map[string]string{"model": modelName, "status": "loading"})
}

// Feature store handlers

func (s *Server) createFeatureGroup(w http.ResponseWriter, r *http.Request) {
	var req featurestore.CreateFeatureGroupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	fg, err := s.featureStoreService.CreateFeatureGroup(r.Context(), req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	respondJSON(w, http.StatusCreated, fg)
}

func (s *Server) createFeatureView(w http.ResponseWriter, r *http.Request) {
	var req featurestore.CreateFeatureViewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	fv, err := s.featureStoreService.CreateFeatureView(r.Context(), req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	respondJSON(w, http.StatusCreated, fv)
}

func (s *Server) getOnlineFeatures(w http.ResponseWriter, r *http.Request) {
	var req featurestore.GetFeaturesRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	features, err := s.featureStoreService.GetOnlineFeatures(r.Context(), req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	respondJSON(w, http.StatusOK, features)
}

func (s *Server) getOfflineFeatures(w http.ResponseWriter, r *http.Request) {
	// Implementation for offline features
	respondJSON(w, http.StatusOK, []any{})
}

// Helper functions

func respondJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.router.ServeHTTP(w, r)
}
```

### 8.2 gRPC Service for High-Performance Serving

For the model serving path, gRPC provides significant advantages over REST: binary serialization with Protocol Buffers is faster than JSON, HTTP/2 enables multiplexed streams, and strongly-typed service definitions prevent mismatched requests. The proto definition below specifies the serving contract, and the Go implementation wraps the same serving service you built in Part 3. This means you get both a REST and gRPC endpoint backed by identical business logic.

```go
// internal/api/grpc/serving.proto
// syntax = "proto3" - //
// package mlplatform.serving;
//
// service ModelServing {
//   rpc Predict(PredictRequest) returns (PredictResponse) - //   rpc PredictBatch(PredictBatchRequest) returns (PredictBatchResponse) - //   rpc LoadModel(LoadModelRequest) returns (LoadModelResponse) - // }
//
// message PredictRequest {
//   string model_name = 1;
//   string stage = 2;
//   map<string, TensorValue> inputs = 3 - // }
//
// message TensorValue {
//   repeated float float_values = 1;
//   repeated int64 int_values = 2 - //   repeated string string_values = 3 - // }
//
// message PredictResponse {
//   string model_name = 1;
//   int32 model_version = 2;
//   map<string, TensorValue> outputs = 3 - //   int64 latency_ms = 4;
// }

// internal/api/grpc/server.go
package grpc

import (
	"context"
	"fmt"

	"ml-platform/internal/service/serving"
	pb "ml-platform/proto"  // Generated protobuf code
)

// Server implements the gRPC ModelServing service
type Server struct {
	pb.UnimplementedModelServingServer
	servingService *serving.Service
}

// NewServer creates a new gRPC server
func NewServer(servingService *serving.Service) *Server {
	return &Server{
		servingService: servingService,
	}
}

// Predict handles single prediction requests
func (s *Server) Predict(ctx context.Context, req *pb.PredictRequest) (*pb.PredictResponse, error) {
	// Convert protobuf request to service request
	inputs := make(map[string]any)
	for key, tensorValue := range req.Inputs {
		if len(tensorValue.FloatValues) > 0 {
			inputs[key] = tensorValue.FloatValues
		} else if len(tensorValue.IntValues) > 0 {
			inputs[key] = tensorValue.IntValues
		} else if len(tensorValue.StringValues) > 0 {
			inputs[key] = tensorValue.StringValues
		}
	}

	servingReq := serving.PredictRequest{
		ModelName: req.ModelName,
		Stage:     convertStage(req.Stage),
		Inputs:    inputs,
	}

	response, err := s.servingService.Predict(ctx, servingReq)
	if err != nil {
		return nil, fmt.Errorf("prediction failed: %w", err)
	}

	// Convert service response to protobuf response
	outputs := make(map[string]*pb.TensorValue)
	for key, value := range response.Outputs {
		tensorValue := &pb.TensorValue{}
		
		switch v := value.(type) {
		case []float32:
			tensorValue.FloatValues = v
		case []int64:
			tensorValue.IntValues = v
		case []string:
			tensorValue.StringValues = v
		}
		
		outputs[key] = tensorValue
	}

	return &pb.PredictResponse{
		ModelName:    response.ModelName,
		ModelVersion: int32(response.ModelVersion),
		Outputs:      outputs,
		LatencyMs:    response.LatencyMS,
	}, nil
}

func convertStage(stage string) domain.ModelStage {
	switch stage {
	case "STAGING":
		return domain.ModelStageStaging
	case "PRODUCTION":
		return domain.ModelStageProduction
	default:
		return domain.ModelStageNone
	}
}
```


---
