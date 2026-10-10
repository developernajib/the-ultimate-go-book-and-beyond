## Deep Dive: Geospatial Matching with H3

H3 is Uber's open-source library that divides the entire Earth into hexagonal grid cells at 16 resolutions. Unlike square grids where diagonal neighbors are farther away than orthogonal ones, hexagons put all six neighbors at the same center-to-center distance, which makes "expand to the surrounding cells" a uniform operation rather than one that stretches along the diagonals.

Use the real library. Rounding latitude and longitude to a few decimal places produces something that superficially resembles a cell index, and it is not one. Rounded lat/lng gives you rectangles whose ground area varies with latitude (a degree of longitude is 111km at the equator and 0km at the poles), the cells do not tile the sphere, they have no hierarchy, and adjacency is undefined. Every property that makes H3 worth using is precisely what the shortcut throws away. It costs one import to be correct.

```go
package geo

import (
	"fmt"

	"github.com/uber/h3-go/v4"
)

type H3Index struct {
	Resolution int
	Cell       h3.Cell
}

func (i H3Index) String() string { return i.Cell.String() }

// GetH3Cell maps a GPS fix to the H3 cell containing it.
//
// LatLngToCell returns (Cell, error) in h3-go v4, and the error is not
// decorative: a phone in a tunnel or a parking garage will hand you NaN, and
// LatLngToCell rejects NaN and infinities.
//
// It does not, however, reject a latitude of 91. H3 wraps out-of-range
// coordinates and returns a perfectly valid-looking cell for somewhere else on
// Earth, with no error at all. That is the dangerous case, because it fails
// silently: a driver with a corrupt fix gets indexed into a cell on the far
// side of the planet, quietly polluting supply counts in a market they have
// never visited. Range-check the input yourself. The library's error return
// covers less than you would assume, which is worth checking for any validation
// you are trusting someone else to do.
func GetH3Cell(lat, lng float64, res int) (H3Index, error) {
	if lat < -90 || lat > 90 || lng < -180 || lng > 180 {
		return H3Index{}, fmt.Errorf("coordinate (%f,%f) out of range", lat, lng)
	}
	c, err := h3.LatLngToCell(h3.NewLatLng(lat, lng), res)
	if err != nil {
		return H3Index{}, fmt.Errorf("h3 index (%f,%f) at res %d: %w", lat, lng, res, err)
	}
	return H3Index{Resolution: res, Cell: c}, nil
}

// MultiResLookup returns the containing cell at progressively coarser
// resolutions, for widening a search or aggregating demand upward:
//
//	res 9 ~0.105 km²  a block or two
//	res 8 ~0.737 km²  a neighborhood
//	res 7 ~5.161 km²  a district
//
// Those are areas, not distances. Resolution 7 is not "a city": a res-7 cell is
// about 5 km², while a city is hundreds.
//
// Coarsening uses Parent rather than re-indexing the raw coordinate. Both
// return the same cell, but Parent is pure integer bit manipulation on the
// index we already have, and it cannot drift from the res-9 cell the way two
// independent lookups could.
func MultiResLookup(lat, lng float64) ([]H3Index, error) {
	base, err := GetH3Cell(lat, lng, 9)
	if err != nil {
		return nil, err
	}

	cells := []H3Index{base}
	for _, r := range []int{8, 7} {
		p, err := base.Cell.Parent(r)
		if err != nil {
			return nil, fmt.Errorf("h3 parent at res %d: %w", r, err)
		}
		cells = append(cells, H3Index{Resolution: r, Cell: p})
	}
	return cells, nil
}

// NearbyCells returns the cell containing the point plus every cell within k
// rings of it. This is how you widen a driver search without re-querying by
// radius: k=1 is the 7 cells of the immediate neighborhood, k=2 is 19 cells.
func NearbyCells(lat, lng float64, res, k int) ([]h3.Cell, error) {
	c, err := GetH3Cell(lat, lng, res)
	if err != nil {
		return nil, err
	}
	ring, err := c.Cell.GridDisk(k)
	if err != nil {
		return nil, fmt.Errorf("h3 grid disk k=%d: %w", k, err)
	}
	return ring, nil
}
```

---
