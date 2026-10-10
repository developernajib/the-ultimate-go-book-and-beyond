package types

import (
	"math"
	"testing"
)

func TestPriceOperations(t *testing.T) {
	p1 := NewPrice(100.50)
	p2 := NewPrice(50.25)

	sum := p1.Add(p2)
	if math.Abs(sum.Float64()-150.75) > 1e-6 {
		t.Errorf("expected 150.75, got %f", sum.Float64())
	}

	diff := p1.Sub(p2)
	if math.Abs(diff.Float64()-50.25) > 1e-6 {
		t.Errorf("expected 50.25, got %f", diff.Float64())
	}

	qty := NewQuantity(2.0)
	prod := p1.Mul(qty)
	if math.Abs(prod.Float64()-201.00) > 1e-6 {
		t.Errorf("expected 201.00, got %f", prod.Float64())
	}
}

func TestQuantityAndSide(t *testing.T) {
	q := NewQuantity(10.5)
	if math.Abs(q.Float64()-10.5) > 1e-6 {
		t.Errorf("expected 10.5, got %f", q.Float64())
	}

	buy := SideBuy
	if buy.String() != "BUY" {
		t.Errorf("expected BUY, got %s", buy.String())
	}

	sell := buy.Opposite()
	if sell != SideSell || sell.String() != "SELL" {
		t.Errorf("expected SELL, got %s", sell.String())
	}

	if sell.Opposite() != SideBuy {
		t.Errorf("expected opposite of SELL to be BUY")
	}
}
