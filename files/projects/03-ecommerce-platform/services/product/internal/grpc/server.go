package grpc

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/example/ecommerce-platform/services/product/internal/domain"
	"github.com/example/ecommerce-platform/services/product/internal/service"
	pb "github.com/example/ecommerce-platform/services/product/proto"
)

// Server implements the ProductService gRPC server
type Server struct {
	pb.UnimplementedProductServiceServer
	productService *service.ProductService
}

// NewServer creates a new gRPC server
func NewServer(productService *service.ProductService) *Server {
	return &Server{
		productService: productService,
	}
}

// CreateProduct creates a new product
func (s *Server) CreateProduct(ctx context.Context, req *pb.CreateProductRequest) (*pb.CreateProductResponse, error) {
	product := &domain.Product{
		Name:        req.Name,
		Description: req.Description,
		SKU:         req.Sku,
		Metadata:    req.Metadata,
	}

	if req.Price != nil {
		product.Currency = req.Price.CurrencyCode
		product.Price = moneyToDecimal(req.Price)
	}

	product.Inventory = req.Inventory

	for _, idStr := range req.CategoryIds {
		categoryID, err := uuid.Parse(idStr)
		if err != nil {
			return nil, status.Errorf(codes.InvalidArgument, "invalid category ID: %v", err)
		}
		product.CategoryIDs = append(product.CategoryIDs, categoryID)
	}

	for _, v := range req.Variants {
		variant := domain.ProductVariant{
			Name:       v.Name,
			SKU:        v.Sku,
			Inventory:  v.Inventory,
			Attributes: v.Attributes,
		}
		if v.Price != nil {
			variant.Currency = v.Price.CurrencyCode
			variant.Price = moneyToDecimal(v.Price)
		}
		product.Variants = append(product.Variants, variant)
	}

	created, err := s.productService.CreateProduct(ctx, product)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "creating product: %v", err)
	}

	return &pb.CreateProductResponse{
		Product: domainProductToProto(created),
	}, nil
}

// GetProduct retrieves a product
func (s *Server) GetProduct(ctx context.Context, req *pb.GetProductRequest) (*pb.GetProductResponse, error) {
	id, err := uuid.Parse(req.Id)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid product ID: %v", err)
	}

	product, err := s.productService.GetProduct(ctx, id)
	if err != nil {
		if err == domain.ErrProductNotFound {
			return nil, status.Error(codes.NotFound, "product not found")
		}
		return nil, status.Errorf(codes.Internal, "getting product: %v", err)
	}

	return &pb.GetProductResponse{
		Product: domainProductToProto(product),
	}, nil
}

// UpdateProduct updates a product
func (s *Server) UpdateProduct(ctx context.Context, req *pb.UpdateProductRequest) (*pb.UpdateProductResponse, error) {
	id, err := uuid.Parse(req.Id)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid product ID: %v", err)
	}

	product, err := s.productService.GetProduct(ctx, id)
	if err != nil {
		if err == domain.ErrProductNotFound {
			return nil, status.Error(codes.NotFound, "product not found")
		}
		return nil, status.Errorf(codes.Internal, "getting product: %v", err)
	}

	if req.Name != nil {
		product.Name = *req.Name
	}
	if req.Description != nil {
		product.Description = *req.Description
	}
	if req.Price != nil {
		product.Price = moneyToDecimal(req.Price)
		product.Currency = req.Price.CurrencyCode
	}
	if req.Inventory != nil {
		product.Inventory = *req.Inventory
	}
	if req.Status != pb.ProductStatus_PRODUCT_STATUS_UNSPECIFIED {
		product.Status = protoStatusToDomain(req.Status)
	}

	updated, err := s.productService.UpdateProduct(ctx, product)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "updating product: %v", err)
	}

	return &pb.UpdateProductResponse{
		Product: domainProductToProto(updated),
	}, nil
}

// DeleteProduct deletes a product
func (s *Server) DeleteProduct(ctx context.Context, req *pb.DeleteProductRequest) (*pb.DeleteProductResponse, error) {
	id, err := uuid.Parse(req.Id)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid product ID: %v", err)
	}

	if err := s.productService.DeleteProduct(ctx, id); err != nil {
		if err == domain.ErrProductNotFound {
			return nil, status.Error(codes.NotFound, "product not found")
		}
		return nil, status.Errorf(codes.Internal, "deleting product: %v", err)
	}

	return &pb.DeleteProductResponse{Success: true}, nil
}

// ListProducts lists products
func (s *Server) ListProducts(ctx context.Context, req *pb.ListProductsRequest) (*pb.ListProductsResponse, error) {
	var categoryIDs []uuid.UUID
	for _, idStr := range req.CategoryIds {
		id, err := uuid.Parse(idStr)
		if err != nil {
			return nil, status.Errorf(codes.InvalidArgument, "invalid category ID: %v", err)
		}
		categoryIDs = append(categoryIDs, id)
	}

	page := 1
	pageSize := 20
	if req.Page != nil {
		if req.Page.Page > 0 {
			page = int(req.Page.Page)
		}
		if req.Page.PageSize > 0 {
			pageSize = int(req.Page.PageSize)
		}
	}

	products, total, err := s.productService.ListProducts(
		ctx,
		categoryIDs,
		protoStatusToDomain(req.Status),
		req.SearchQuery,
		page,
		pageSize,
	)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "listing products: %v", err)
	}

	var protoProducts []*pb.Product
	for _, p := range products {
		protoProducts = append(protoProducts, domainProductToProto(p))
	}

	totalPages := (total + pageSize - 1) / pageSize

	return &pb.ListProductsResponse{
		Products: protoProducts,
		Page: &pb.PageResponse{
			TotalCount: int32(total),
			Page:       int32(page),
			PageSize:   int32(pageSize),
			TotalPages: int32(totalPages),
		},
	}, nil
}

// CheckInventory checks if inventory is available
func (s *Server) CheckInventory(ctx context.Context, req *pb.CheckInventoryRequest) (*pb.CheckInventoryResponse, error) {
	productID, err := uuid.Parse(req.ProductId)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid product ID: %v", err)
	}

	var variantID *uuid.UUID
	if req.VariantId != nil {
		id, err := uuid.Parse(*req.VariantId)
		if err != nil {
			return nil, status.Errorf(codes.InvalidArgument, "invalid variant ID: %v", err)
		}
		variantID = &id
	}

	available, currentInventory, err := s.productService.CheckInventory(ctx, productID, variantID, req.Quantity)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "checking inventory: %v", err)
	}

	return &pb.CheckInventoryResponse{
		Available:        available,
		CurrentInventory: currentInventory,
	}, nil
}

// ReserveInventory reserves inventory
func (s *Server) ReserveInventory(ctx context.Context, req *pb.ReserveInventoryRequest) (*pb.ReserveInventoryResponse, error) {
	var items []domain.InventoryReservation
	for _, item := range req.Items {
		productID, err := uuid.Parse(item.ProductId)
		if err != nil {
			return nil, status.Errorf(codes.InvalidArgument, "invalid product ID: %v", err)
		}

		reservation := domain.InventoryReservation{
			ProductID: productID,
			Quantity:  item.Quantity,
		}

		if item.VariantId != nil {
			variantID, err := uuid.Parse(*item.VariantId)
			if err != nil {
				return nil, status.Errorf(codes.InvalidArgument, "invalid variant ID: %v", err)
			}
			reservation.VariantID = &variantID
		}

		items = append(items, reservation)
	}

	reservationID, expiresAt, err := s.productService.ReserveInventory(ctx, items, 15)
	if err != nil {
		if err == domain.ErrInsufficientInventory {
			return nil, status.Error(codes.FailedPrecondition, "insufficient inventory")
		}
		return nil, status.Errorf(codes.Internal, "reserving inventory: %v", err)
	}

	return &pb.ReserveInventoryResponse{
		Success:       true,
		ReservationId: reservationID.String(),
		ExpiresAt:     timestamppb.New(expiresAt),
	}, nil
}

// ReleaseInventory releases a reservation
func (s *Server) ReleaseInventory(ctx context.Context, req *pb.ReleaseInventoryRequest) (*pb.ReleaseInventoryResponse, error) {
	reservationID, err := uuid.Parse(req.ReservationId)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid reservation ID: %v", err)
	}

	if err := s.productService.ReleaseInventory(ctx, reservationID); err != nil {
		return nil, status.Errorf(codes.Internal, "releasing inventory: %v", err)
	}

	return &pb.ReleaseInventoryResponse{Success: true}, nil
}

// CommitInventory commits a reservation
func (s *Server) CommitInventory(ctx context.Context, req *pb.CommitInventoryRequest) (*pb.CommitInventoryResponse, error) {
	reservationID, err := uuid.Parse(req.ReservationId)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid reservation ID: %v", err)
	}

	if err := s.productService.CommitInventory(ctx, reservationID); err != nil {
		if err == domain.ErrInsufficientInventory {
			return nil, status.Error(codes.FailedPrecondition, "insufficient inventory")
		}
		if err == domain.ErrReservationExpired {
			return nil, status.Error(codes.DeadlineExceeded, "reservation expired")
		}
		return nil, status.Errorf(codes.Internal, "committing inventory: %v", err)
	}

	return &pb.CommitInventoryResponse{Success: true}, nil
}

// ListCategories lists categories
func (s *Server) ListCategories(_ context.Context, _ *pb.ListCategoriesRequest) (*pb.ListCategoriesResponse, error) {
	return &pb.ListCategoriesResponse{
		Categories: []*pb.Category{},
	}, nil
}

// mustEmbedUnimplementedProductServiceServer satisfies the interface
func (s *Server) mustEmbedUnimplementedProductServiceServer() {}

// Helper functions

func domainProductToProto(p *domain.Product) *pb.Product {
	product := &pb.Product{
		Id:          p.ID.String(),
		Name:        p.Name,
		Description: p.Description,
		Sku:         p.SKU,
		Price:       decimalToMoney(p.Price, p.Currency),
		Inventory:   p.Inventory,
		Status:      domainStatusToProto(p.Status),
		Metadata:    p.Metadata,
		CreatedAt:   timestamppb.New(p.CreatedAt),
		UpdatedAt:   timestamppb.New(p.UpdatedAt),
	}

	for _, id := range p.CategoryIDs {
		product.CategoryIds = append(product.CategoryIds, id.String())
	}

	for _, v := range p.Variants {
		product.Variants = append(product.Variants, &pb.ProductVariant{
			Id:         v.ID.String(),
			ProductId:  v.ProductID.String(),
			Name:       v.Name,
			Sku:        v.SKU,
			Price:      decimalToMoney(v.Price, v.Currency),
			Inventory:  v.Inventory,
			Attributes: v.Attributes,
		})
	}

	for _, img := range p.Images {
		product.Images = append(product.Images, &pb.ProductImage{
			Id:      img.ID.String(),
			Url:     img.URL,
			AltText: img.AltText,
			Order:   img.Order,
		})
	}

	return product
}

func domainStatusToProto(s domain.ProductStatus) pb.ProductStatus {
	switch s {
	case domain.ProductStatusActive:
		return pb.ProductStatus_PRODUCT_STATUS_ACTIVE
	case domain.ProductStatusInactive:
		return pb.ProductStatus_PRODUCT_STATUS_INACTIVE
	case domain.ProductStatusOutOfStock:
		return pb.ProductStatus_PRODUCT_STATUS_OUT_OF_STOCK
	case domain.ProductStatusDiscontinued:
		return pb.ProductStatus_PRODUCT_STATUS_DISCONTINUED
	default:
		return pb.ProductStatus_PRODUCT_STATUS_UNSPECIFIED
	}
}

func protoStatusToDomain(s pb.ProductStatus) domain.ProductStatus {
	switch s {
	case pb.ProductStatus_PRODUCT_STATUS_ACTIVE:
		return domain.ProductStatusActive
	case pb.ProductStatus_PRODUCT_STATUS_INACTIVE:
		return domain.ProductStatusInactive
	case pb.ProductStatus_PRODUCT_STATUS_OUT_OF_STOCK:
		return domain.ProductStatusOutOfStock
	case pb.ProductStatus_PRODUCT_STATUS_DISCONTINUED:
		return domain.ProductStatusDiscontinued
	default:
		return ""
	}
}

func moneyToDecimal(m *pb.Money) decimal.Decimal {
	if m == nil {
		return decimal.Zero
	}
	return decimal.NewFromInt(m.Units).Div(decimal.NewFromInt(100))
}

func decimalToMoney(d decimal.Decimal, currency string) *pb.Money {
	units := d.Mul(decimal.NewFromInt(100)).IntPart()
	return &pb.Money{
		CurrencyCode: currency,
		Units:        units,
		Nanos:        0,
	}
}

// ensure fmt is used
var _ = fmt.Sprintf
