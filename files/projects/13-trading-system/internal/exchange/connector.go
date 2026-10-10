// internal/exchange/connector.go
package exchange

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/example/trading-system/pkg/types"
)

// Connector defines exchange connector interface
type Connector interface {
	// Connect establishes connection to exchange
	Connect(ctx context.Context) error

	// Disconnect closes connection
	Disconnect() error

	// SubmitOrder submits an order
	SubmitOrder(order *types.Order) error

	// CancelOrder cancels an order
	CancelOrder(orderID types.OrderID) error

	// SubscribeMarketData subscribes to market data
	SubscribeMarketData(symbols []types.Symbol) error

	// GetID returns connector ID
	GetID() string

	// Event handler registration
	OnTrade(handler func(*types.Trade))
	OnQuote(handler func(*types.Quote))
	OnBook(handler func(*types.OrderBook))
	OnFill(handler func(*types.Fill))
	OnUpdate(handler func(*types.Order))
}

// WebSocketConnector implements WebSocket-based exchange connectivity
type WebSocketConnector struct {
	id       string
	url      string
	apiKey   string
	secret   string

	conn     *websocket.Conn
	connMu   sync.Mutex

	// Message handlers
	onTrade   func(*types.Trade)
	onQuote   func(*types.Quote)
	onBook    func(*types.OrderBook)
	onFill    func(*types.Fill)
	onUpdate  func(*types.Order)

	// State
	subscribed map[types.Symbol]bool
	subMu      sync.RWMutex

	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
}

// NewWebSocketConnector creates a WebSocket connector
func NewWebSocketConnector(id, url, apiKey, secret string) *WebSocketConnector {
	ctx, cancel := context.WithCancel(context.Background())

	return &WebSocketConnector{
		id:         id,
		url:        url,
		apiKey:     apiKey,
		secret:     secret,
		subscribed: make(map[types.Symbol]bool),
		ctx:        ctx,
		cancel:     cancel,
	}
}

// Connect implements Connector
func (c *WebSocketConnector) Connect(ctx context.Context) error {
	c.connMu.Lock()
	defer c.connMu.Unlock()

	dialer := websocket.DefaultDialer
	conn, _, err := dialer.Dial(c.url, nil)
	if err != nil {
		return fmt.Errorf("websocket dial failed: %w", err)
	}

	c.conn = conn

	// Start message reader
	c.wg.Add(1)
	go c.readMessages()

	// Send authentication if required
	if err := c.authenticate(); err != nil {
		return fmt.Errorf("authentication failed: %w", err)
	}

	return nil
}

// Disconnect implements Connector
func (c *WebSocketConnector) Disconnect() error {
	c.cancel()

	c.connMu.Lock()
	if c.conn != nil {
		c.conn.Close()
	}
	c.connMu.Unlock()

	c.wg.Wait()

	return nil
}

// SubmitOrder implements Connector
func (c *WebSocketConnector) SubmitOrder(order *types.Order) error {
	// Convert order to exchange-specific format
	msg := map[string]any{
		"type":      "order",
		"action":    "new",
		"symbol":    string(order.Symbol),
		"side":      order.Side.String(),
		"orderType": order.Type.String(),
		"price":     order.Price.Float64(),
		"quantity":  order.Quantity.Float64(),
		"clientId":  string(order.ID),
	}

	return c.sendMessage(msg)
}

// CancelOrder implements Connector
func (c *WebSocketConnector) CancelOrder(orderID types.OrderID) error {
	msg := map[string]any{
		"type":    "order",
		"action":  "cancel",
		"orderId": string(orderID),
	}

	return c.sendMessage(msg)
}

// SubscribeMarketData implements Connector
func (c *WebSocketConnector) SubscribeMarketData(symbols []types.Symbol) error {
	msg := map[string]any{
		"type":    "subscribe",
		"channel": "marketdata",
		"symbols": symbols,
	}

	if err := c.sendMessage(msg); err != nil {
		return err
	}

	// Mark symbols as subscribed
	c.subMu.Lock()
	for _, symbol := range symbols {
		c.subscribed[symbol] = true
	}
	c.subMu.Unlock()

	return nil
}

// GetID implements Connector
func (c *WebSocketConnector) GetID() string {
	return c.id
}

// OnTrade registers trade handler
func (c *WebSocketConnector) OnTrade(handler func(*types.Trade)) {
	c.onTrade = handler
}

// OnQuote registers quote handler
func (c *WebSocketConnector) OnQuote(handler func(*types.Quote)) {
	c.onQuote = handler
}

// OnBook registers order book handler
func (c *WebSocketConnector) OnBook(handler func(*types.OrderBook)) {
	c.onBook = handler
}

// OnFill registers fill handler
func (c *WebSocketConnector) OnFill(handler func(*types.Fill)) {
	c.onFill = handler
}

// OnUpdate registers order update handler
func (c *WebSocketConnector) OnUpdate(handler func(*types.Order)) {
	c.onUpdate = handler
}

// readMessages reads messages from WebSocket
func (c *WebSocketConnector) readMessages() {
	defer c.wg.Done()

	for {
		select {
		case <-c.ctx.Done():
			return

		default:
			c.connMu.Lock()
			conn := c.conn
			c.connMu.Unlock()

			if conn == nil {
				return
			}

			_, data, err := conn.ReadMessage()
			if err != nil {
				// Handle reconnection
				c.handleDisconnection(err)
				return
			}

			c.handleMessage(data)
		}
	}
}

// handleMessage processes incoming messages
func (c *WebSocketConnector) handleMessage(data []byte) {
	var msg map[string]any
	if err := json.Unmarshal(data, &msg); err != nil {
		return
	}

	msgType, ok := msg["type"].(string)
	if !ok {
		return
	}

	switch msgType {
	case "trade":
		c.handleTradeMessage(msg)
	case "quote":
		c.handleQuoteMessage(msg)
	case "book":
		c.handleBookMessage(msg)
	case "fill":
		c.handleFillMessage(msg)
	case "orderUpdate":
		c.handleOrderUpdateMessage(msg)
	}
}

// handleTradeMessage processes trade messages
func (c *WebSocketConnector) handleTradeMessage(msg map[string]any) {
	if c.onTrade == nil {
		return
	}

	trade := &types.Trade{
		Symbol:    types.Symbol(msg["symbol"].(string)),
		Price:     types.NewPrice(msg["price"].(float64)),
		Quantity:  types.NewQuantity(msg["quantity"].(float64)),
		Timestamp: time.Now(),
	}

	c.onTrade(trade)
}

// handleQuoteMessage processes quote messages
func (c *WebSocketConnector) handleQuoteMessage(msg map[string]any) {
	if c.onQuote == nil {
		return
	}

	quote := &types.Quote{
		Symbol:    types.Symbol(msg["symbol"].(string)),
		BidPrice:  types.NewPrice(msg["bidPrice"].(float64)),
		BidSize:   types.NewQuantity(msg["bidSize"].(float64)),
		AskPrice:  types.NewPrice(msg["askPrice"].(float64)),
		AskSize:   types.NewQuantity(msg["askSize"].(float64)),
		Timestamp: time.Now(),
	}

	c.onQuote(quote)
}

// handleBookMessage processes order book messages
func (c *WebSocketConnector) handleBookMessage(msg map[string]any) {
	if c.onBook == nil {
		return
	}

	// Parse order book from message
	// This is exchange-specific
}

// handleFillMessage processes fill messages
func (c *WebSocketConnector) handleFillMessage(msg map[string]any) {
	if c.onFill == nil {
		return
	}

	fill := &types.Fill{
		OrderID:   types.OrderID(msg["orderId"].(string)),
		Symbol:    types.Symbol(msg["symbol"].(string)),
		Price:     types.NewPrice(msg["price"].(float64)),
		Quantity:  types.NewQuantity(msg["quantity"].(float64)),
		Timestamp: time.Now(),
	}

	c.onFill(fill)
}

// handleOrderUpdateMessage processes order update messages
func (c *WebSocketConnector) handleOrderUpdateMessage(msg map[string]any) {
	if c.onUpdate == nil {
		return
	}

	// Parse order update
	// This is exchange-specific
}

// sendMessage sends a message to the exchange
func (c *WebSocketConnector) sendMessage(msg any) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	c.connMu.Lock()
	defer c.connMu.Unlock()

	if c.conn == nil {
		return fmt.Errorf("not connected")
	}

	return c.conn.WriteMessage(websocket.TextMessage, data)
}

// authenticate sends authentication message
func (c *WebSocketConnector) authenticate() error {
	// Exchange-specific authentication
	// This would generate signature using HMAC-SHA256

	msg := map[string]any{
		"type":   "auth",
		"apiKey": c.apiKey,
		// "signature": generateSignature(c.secret, ...),
		// "timestamp": time.Now().Unix(),
	}

	return c.sendMessage(msg)
}

// handleDisconnection handles connection loss
func (c *WebSocketConnector) handleDisconnection(err error) {
	// Log disconnection
	// Attempt reconnection with exponential backoff

	backoff := time.Second
	maxBackoff := time.Minute

	for {
		select {
		case <-c.ctx.Done():
			return

		case <-time.After(backoff):
			if err := c.Connect(c.ctx); err == nil {
				// Reconnected successfully
				// Resubscribe to market data
				c.resubscribe()
				return
			}

			// Increase backoff
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
		}
	}
}

// resubscribe resubscribes to market data after reconnection
func (c *WebSocketConnector) resubscribe() {
	c.subMu.RLock()
	var symbols []types.Symbol
	for symbol := range c.subscribed {
		symbols = append(symbols, symbol)
	}
	c.subMu.RUnlock()

	if len(symbols) > 0 {
		c.SubscribeMarketData(symbols)
	}
}
