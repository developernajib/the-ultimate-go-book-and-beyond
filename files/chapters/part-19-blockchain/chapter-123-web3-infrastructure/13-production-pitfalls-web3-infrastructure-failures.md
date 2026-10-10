## 123.13 Production Pitfalls: Web3 Infrastructure Failures

### Pitfall 1: The IPFS Gateway Centralization Trap

**Real Incident Report**: An NFT marketplace relied solely on `gateway.pinata.cloud` for IPFS content. When Pinata experienced a 4-hour outage, all NFT images on the platform displayed broken. Users couldn't verify their NFT assets, and trading volume dropped 90%.

**The Anti-Pattern**:
```go
// DANGEROUS: Single IPFS gateway
func getIPFSContent(cid string) ([]byte, error) {
    url := fmt.Sprintf("https://gateway.pinata.cloud/ipfs/%s", cid)
    resp, err := http.Get(url)
    if err != nil {
        return nil, err // No fallback!
    }
    return io.ReadAll(resp.Body)
}

func getNFTMetadata(tokenURI string) (*NFTMetadata, error) {
    // Single point of failure
    data, err := getIPFSContent(extractCID(tokenURI))
    if err != nil {
        return nil, err
    }
    var meta NFTMetadata
    json.Unmarshal(data, &meta)
    return &meta, nil
}
```

**The Better Approach**:
```go
type ResilientIPFSClient struct {
    gateways      []Gateway
    localNode     *ipfs.Shell
    cache         *redis.Client
    cacheTTL      time.Duration
    timeout       time.Duration
    healthChecker *GatewayHealthChecker
}

type Gateway struct {
    Name      string
    URL       string
    RateLimit int // requests per second
    Healthy   atomic.Bool
    Latency   atomic.Int64
}

func NewResilientIPFSClient() *ResilientIPFSClient {
    client := &ResilientIPFSClient{
        gateways: []Gateway{
            {Name: "cloudflare", URL: "https://cloudflare-ipfs.com/ipfs/", RateLimit: 100},
            {Name: "pinata", URL: "https://gateway.pinata.cloud/ipfs/", RateLimit: 50},
            {Name: "infura", URL: "https://ipfs.infura.io/ipfs/", RateLimit: 50},
            {Name: "dweb", URL: "https://dweb.link/ipfs/", RateLimit: 30},
            {Name: "w3s", URL: "https://w3s.link/ipfs/", RateLimit: 30},
        },
        timeout:  10 * time.Second,
        cacheTTL: 24 * time.Hour,
    }

    // Start health checking
    go client.healthChecker.Start()

    return client
}

func (c *ResilientIPFSClient) Get(ctx context.Context, cid string) ([]byte, error) {
    // Check cache first
    if c.cache != nil {
        if data, err := c.cache.Get(ctx, "ipfs:"+cid).Bytes(); err == nil {
            return data, nil
        }
    }

    // Try local node first (fastest)
    if c.localNode != nil {
        ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
        data, err := c.localNode.Cat(cid)
        cancel()
        if err == nil {
            c.cacheContent(ctx, cid, data)
            return data, nil
        }
    }

    // Try gateways in order of health/latency
    healthyGateways := c.healthChecker.GetHealthyGateways()

    // Sort by latency
    sort.Slice(healthyGateways, func(i, j int) bool {
        return healthyGateways[i].Latency.Load() < healthyGateways[j].Latency.Load()
    })

    var lastErr error
    for _, gw := range healthyGateways {
        ctx, cancel := context.WithTimeout(ctx, c.timeout)
        data, err := c.fetchFromGateway(ctx, gw, cid)
        cancel()

        if err == nil {
            c.cacheContent(ctx, cid, data)
            return data, nil
        }
        lastErr = err
    }

    return nil, fmt.Errorf("all gateways failed, last error: %w", lastErr)
}

func (c *ResilientIPFSClient) fetchFromGateway(ctx context.Context, gw Gateway, cid string) ([]byte, error) {
    start := time.Now()
    defer func() {
        gw.Latency.Store(time.Since(start).Milliseconds())
    }()

    req, _ := http.NewRequestWithContext(ctx, "GET", gw.URL+cid, nil)
    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        gw.Healthy.Store(false)
        return nil, err
    }
    defer resp.Body.Close()

    if resp.StatusCode != 200 {
        if resp.StatusCode == 429 || resp.StatusCode >= 500 {
            gw.Healthy.Store(false)
        }
        return nil, fmt.Errorf("gateway %s returned %d", gw.Name, resp.StatusCode)
    }

    gw.Healthy.Store(true)
    return io.ReadAll(io.LimitReader(resp.Body, 10*1024*1024)) // 10MB limit
}

type GatewayHealthChecker struct {
    gateways []*Gateway
    interval time.Duration
    testCID  string // Well-known CID for health checks
}

func (h *GatewayHealthChecker) Start() {
    ticker := time.NewTicker(h.interval)
    for range ticker.C {
        for _, gw := range h.gateways {
            go h.checkGateway(gw)
        }
    }
}

func (h *GatewayHealthChecker) checkGateway(gw *Gateway) {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    start := time.Now()
    resp, err := http.Get(gw.URL + h.testCID)
    latency := time.Since(start)

    if err != nil || resp.StatusCode != 200 {
        gw.Healthy.Store(false)
        return
    }
    resp.Body.Close()

    gw.Healthy.Store(true)
    gw.Latency.Store(latency.Milliseconds())
}
```

**Key Insight**: Never rely on a single IPFS gateway. Run your own node for critical content, use multiple public gateways with health checking, and cache content locally.

---

### Pitfall 2: The Graph Indexer Dependency

**Real Incident Report**: A DeFi dashboard depended entirely on The Graph's hosted service for historical data. When the indexer fell behind by 1000 blocks during high network activity, the dashboard showed stale positions, causing users to make decisions based on outdated data.

**The Anti-Pattern**:
```go
// DANGEROUS: Single Graph endpoint with no freshness check
func getPositions(ctx context.Context, user string) ([]Position, error) {
    query := `{
        positions(where: {user: $user}) {
            id
            token0
            token1
            liquidity
        }
    }`

    // No check if indexer is synced!
    result, err := graphClient.Query(ctx, query, map[string]any{"user": user})
    if err != nil {
        return nil, err
    }
    return parsePositions(result), nil
}
```

**The Better Approach**:
```go
type ResilientGraphClient struct {
    endpoints     []GraphEndpoint
    rpcClient     *ethclient.Client
    maxBlockLag   uint64
    fallbackStore *FallbackStore
}

type GraphEndpoint struct {
    Name        string
    URL         string
    Healthy     atomic.Bool
    BlockHeight atomic.Uint64
}

type IndexerMeta struct {
    Block struct {
        Number int64 `json:"number"`
        Hash   string `json:"hash"`
    } `json:"block"`
    HasIndexingErrors bool `json:"hasIndexingErrors"`
}

func (c *ResilientGraphClient) Query(
    ctx context.Context,
    query string,
    variables map[string]any,
) ([]byte, *IndexerMeta, error) {
    // Get current block height from RPC
    currentBlock, err := c.rpcClient.BlockNumber(ctx)
    if err != nil {
        return nil, nil, fmt.Errorf("failed to get current block: %w", err)
    }

    // Include meta in query to check indexer status
    metaQuery := fmt.Sprintf(`{
        _meta {
            block { number hash }
            hasIndexingErrors
        }
        %s
    }`, query)

    // Try endpoints in order of freshness
    var syncedEndpoints []GraphEndpoint
    for _, ep := range c.endpoints {
        if ep.Healthy.Load() && currentBlock-ep.BlockHeight.Load() <= c.maxBlockLag {
            syncedEndpoints = append(syncedEndpoints, ep)
        }
    }

    // Sort by block height (most synced first)
    sort.Slice(syncedEndpoints, func(i, j int) bool {
        return syncedEndpoints[i].BlockHeight.Load() > syncedEndpoints[j].BlockHeight.Load()
    })

    var lastErr error
    for _, ep := range syncedEndpoints {
        result, meta, err := c.queryEndpoint(ctx, ep, metaQuery, variables)
        if err != nil {
            lastErr = err
            ep.Healthy.Store(false)
            continue
        }

        // Update endpoint block height
        ep.BlockHeight.Store(uint64(meta.Block.Number))

        // Check for indexing errors
        if meta.HasIndexingErrors {
            log.Printf("Warning: endpoint %s has indexing errors", ep.Name)
        }

        // Verify block height is acceptable
        if currentBlock-uint64(meta.Block.Number) > c.maxBlockLag {
            lastErr = fmt.Errorf("endpoint %s is %d blocks behind",
                ep.Name, currentBlock-uint64(meta.Block.Number))
            continue
        }

        return result, meta, nil
    }

    // All Graph endpoints failed - use fallback
    if c.fallbackStore != nil {
        log.Println("Graph endpoints unavailable, using fallback store")
        return c.fallbackStore.Query(ctx, query, variables)
    }

    return nil, nil, fmt.Errorf("all graph endpoints failed: %w", lastErr)
}

// FallbackStore provides direct RPC-based queries as backup
type FallbackStore struct {
    rpcClient    *ethclient.Client
    eventFilters map[string]EventFilter
    cache        *redis.Client
}

func (s *FallbackStore) Query(
    ctx context.Context,
    query string,
    variables map[string]any,
) ([]byte, *IndexerMeta, error) {
    // Parse query to understand what data is needed
    queryType := parseQueryType(query)

    switch queryType {
    case "positions":
        return s.getPositionsFromRPC(ctx, variables["user"].(string))
    case "swaps":
        return s.getSwapsFromRPC(ctx, variables)
    default:
        return nil, nil, errors.New("fallback not supported for this query")
    }
}

func (s *FallbackStore) getPositionsFromRPC(ctx context.Context, user string) ([]byte, *IndexerMeta, error) {
    // Filter Transfer events to/from user to build position history
    userAddr := common.HexToAddress(user)

    logs, err := s.rpcClient.FilterLogs(ctx, ethereum.FilterQuery{
        Topics: [][]common.Hash{
            {TransferEventSignature},
            nil,
            {common.BytesToHash(userAddr.Bytes())},
        },
        FromBlock: big.NewInt(0),
        ToBlock:   nil,
    })
    if err != nil {
        return nil, nil, err
    }

    positions := buildPositionsFromLogs(logs)

    // Get current block for meta
    header, _ := s.rpcClient.HeaderByNumber(ctx, nil)
    meta := &IndexerMeta{
        Block: struct {
            Number int64  `json:"number"`
            Hash   string `json:"hash"`
        }{
            Number: header.Number.Int64(),
            Hash:   header.Hash().Hex(),
        },
    }

    result, _ := json.Marshal(positions)
    return result, meta, nil
}
```

**Key Insight**: Always check indexer sync status before trusting Graph data. Maintain multiple Graph endpoints and implement RPC-based fallbacks for critical queries.

---

### Pitfall 3: The Node Sync State Blindspot

**Real Incident Report**: A trading bot connected to a node that was syncing but not fully synced. The bot read stale state, executed trades based on outdated prices, and lost \$50K before the team realized the node was 200 blocks behind.

**The Anti-Pattern**:
```go
// DANGEROUS: No sync status check
func getTokenBalance(ctx context.Context, client *ethclient.Client, token, user common.Address) (*big.Int, error) {
    erc20, _ := NewERC20(token, client)
    // Could be reading from a node that's still syncing!
    return erc20.BalanceOf(nil, user)
}
```

**The Better Approach**:
```go
type SyncAwareClient struct {
    clients       []*ethclient.Client
    maxBlockDiff  uint64
    syncChecker   *SyncStatusChecker
}

type SyncStatus struct {
    ClientIndex     int
    IsSyncing       bool
    CurrentBlock    uint64
    HighestBlock    uint64
    BlocksBehind    uint64
    PeerCount       uint64
    LastChecked     time.Time
}

type SyncStatusChecker struct {
    clients   []*ethclient.Client
    statuses  []SyncStatus
    mu        sync.RWMutex
    interval  time.Duration
}

func (c *SyncStatusChecker) Start() {
    ticker := time.NewTicker(c.interval)
    for range ticker.C {
        c.checkAllClients()
    }
}

func (c *SyncStatusChecker) checkAllClients() {
    var wg sync.WaitGroup
    statuses := make([]SyncStatus, len(c.clients))

    // Get reference block from multiple sources
    var referenceBlocks []uint64
    for i, client := range c.clients {
        wg.Add(1)
        go func(idx int, cl *ethclient.Client) {
            defer wg.Done()

            status := SyncStatus{
                ClientIndex: idx,
                LastChecked: time.Now(),
            }

            // Check sync progress
            progress, err := cl.SyncProgress(context.Background())
            if err != nil {
                status.IsSyncing = true
                statuses[idx] = status
                return
            }

            if progress != nil {
                status.IsSyncing = true
                status.CurrentBlock = progress.CurrentBlock
                status.HighestBlock = progress.HighestBlock
                status.BlocksBehind = progress.HighestBlock - progress.CurrentBlock
            } else {
                // Not syncing - get current block
                blockNum, err := cl.BlockNumber(context.Background())
                if err == nil {
                    status.CurrentBlock = blockNum
                    referenceBlocks = append(referenceBlocks, blockNum)
                }
            }

            // Get peer count
            if rpcClient, ok := cl.Client().(*rpc.Client); ok {
                var peerCount hexutil.Uint64
                rpcClient.Call(&peerCount, "net_peerCount")
                status.PeerCount = uint64(peerCount)
            }

            statuses[idx] = status
        }(i, client)
    }
    wg.Wait()

    // Calculate blocks behind for non-syncing clients
    if len(referenceBlocks) > 0 {
        sort.Slice(referenceBlocks, func(i, j int) bool {
            return referenceBlocks[i] > referenceBlocks[j]
        })
        highestBlock := referenceBlocks[0]

        for i := range statuses {
            if !statuses[i].IsSyncing && statuses[i].CurrentBlock > 0 {
                statuses[i].BlocksBehind = highestBlock - statuses[i].CurrentBlock
            }
        }
    }

    c.mu.Lock()
    c.statuses = statuses
    c.mu.Unlock()
}

func (c *SyncStatusChecker) GetSyncedClient() (*ethclient.Client, error) {
    c.mu.RLock()
    defer c.mu.RUnlock()

    var bestClient *ethclient.Client
    var minBlocksBehind uint64 = math.MaxUint64

    for _, status := range c.statuses {
        if status.IsSyncing {
            continue
        }
        if status.BlocksBehind < minBlocksBehind {
            minBlocksBehind = status.BlocksBehind
            bestClient = c.clients[status.ClientIndex]
        }
    }

    if bestClient == nil {
        return nil, errors.New("no synced clients available")
    }

    return bestClient, nil
}

func (c *SyncAwareClient) GetBalance(ctx context.Context, token, user common.Address) (*big.Int, error) {
    client, err := c.syncChecker.GetSyncedClient()
    if err != nil {
        return nil, err
    }

    // Double check with block number comparison
    localBlock, err := client.BlockNumber(ctx)
    if err != nil {
        return nil, err
    }

    // Compare with another client
    otherClient, _ := c.getAlternateClient(client)
    if otherClient != nil {
        otherBlock, err := otherClient.BlockNumber(ctx)
        if err == nil && otherBlock > localBlock+c.maxBlockDiff {
            return nil, fmt.Errorf("client is %d blocks behind", otherBlock-localBlock)
        }
    }

    erc20, err := NewERC20(token, client)
    if err != nil {
        return nil, err
    }

    return erc20.BalanceOf(&bind.CallOpts{Context: ctx}, user)
}
```

**Key Insight**: Always verify node sync status before trusting state reads. Use `eth_syncing` and compare block numbers across multiple nodes. Never trade on data from a syncing node.

---

### Pitfall 4: The Mempool Monitoring Gap

**Real Incident Report**: A liquidation bot monitored only confirmed transactions. Competitors detected liquidatable positions in the mempool and front-ran every liquidation opportunity. The bot never won a single liquidation despite perfect on-chain detection.

**The Anti-Pattern**:
```go
// DANGEROUS: Only watching confirmed blocks
func watchLiquidations(ctx context.Context, client *ethclient.Client) {
    headers := make(chan *types.Header)
    sub, _ := client.SubscribeNewHead(ctx, headers)

    for header := range headers {
        // By the time we see this, mempool watchers have already acted!
        block, _ := client.BlockByHash(ctx, header.Hash())
        for _, tx := range block.Transactions() {
            if isLiquidationCall(tx) {
                attemptLiquidation(tx) // Too late!
            }
        }
    }
}
```

**The Better Approach**:
```go
type MempoolMonitor struct {
    gethClient      *rpc.Client
    flashbotsClient *FlashbotsClient
    txHandlers      map[string]TxHandler
    pendingTxs      *sync.Map
}

type TxHandler func(ctx context.Context, tx *types.Transaction) error

func (m *MempoolMonitor) Start(ctx context.Context) error {
    // Subscribe to pending transactions
    pendingTxs := make(chan common.Hash, 1000)

    sub, err := m.gethClient.EthSubscribe(ctx, pendingTxs, "newPendingTransactions")
    if err != nil {
        return err
    }
    defer sub.Unsubscribe()

    // Process pending transactions in parallel
    for i := 0; i < 10; i++ {
        go m.processPendingTxs(ctx, pendingTxs)
    }

    <-ctx.Done()
    return nil
}

func (m *MempoolMonitor) processPendingTxs(ctx context.Context, txHashes <-chan common.Hash) {
    for hash := range txHashes {
        // Get full transaction
        var tx *types.Transaction
        err := m.gethClient.CallContext(ctx, &tx, "eth_getTransactionByHash", hash)
        if err != nil || tx == nil {
            continue
        }

        // Decode transaction
        method, err := m.decodeTransaction(tx)
        if err != nil {
            continue
        }

        // Check if we have a handler for this method
        if handler, ok := m.txHandlers[method]; ok {
            // Mark as being processed
            if _, loaded := m.pendingTxs.LoadOrStore(hash, time.Now()); loaded {
                continue // Already processing
            }

            go func(tx *types.Transaction) {
                defer m.pendingTxs.Delete(tx.Hash())

                if err := handler(ctx, tx); err != nil {
                    log.Printf("Handler error: %v", err)
                }
            }(tx)
        }
    }
}

type LiquidationBot struct {
    mempoolMonitor *MempoolMonitor
    flashbots      *FlashbotsClient
    lendingPool    *AaveLendingPool
}

func (b *LiquidationBot) Start(ctx context.Context) error {
    // Register handlers for relevant mempool transactions
    b.mempoolMonitor.txHandlers["borrow"] = b.handleBorrow
    b.mempoolMonitor.txHandlers["withdraw"] = b.handleWithdraw
    b.mempoolMonitor.txHandlers["repay"] = b.handleRepay

    return b.mempoolMonitor.Start(ctx)
}

func (b *LiquidationBot) handleBorrow(ctx context.Context, tx *types.Transaction) error {
    // Decode borrow parameters
    user, amount, err := decodeBorrowParams(tx)
    if err != nil {
        return err
    }

    // Simulate post-borrow health factor
    currentHealth, err := b.lendingPool.GetUserAccountData(nil, user)
    if err != nil {
        return err
    }

    // Calculate new health factor after this borrow
    newHealth := simulateHealthFactor(currentHealth, amount)

    if newHealth.Cmp(big.NewInt(1e18)) < 0 {
        // Position will be liquidatable after this borrow!
        // Build liquidation bundle

        bundle := &FlashbotsBundle{
            Transactions: []string{
                // First: Let their borrow execute
                hexutil.Encode(tx.Data()),
                // Second: Our liquidation right after
                b.buildLiquidationTx(user),
            },
        }

        // Submit backrun bundle
        result, err := b.flashbots.SendBundle(ctx, bundle)
        if err != nil {
            return err
        }

        log.Printf("Submitted liquidation bundle: %s", result.BundleHash)
    }

    return nil
}

// Watch for price oracle updates that could trigger liquidations
func (b *LiquidationBot) watchOracleUpdates(ctx context.Context) {
    // Subscribe to Chainlink oracle updates
    oracleFilter := ethereum.FilterQuery{
        Topics: [][]common.Hash{{AnswerUpdatedEventSignature}},
    }

    logs := make(chan types.Log)
    sub, _ := b.client.SubscribeFilterLogs(ctx, oracleFilter, logs)

    for log := range logs {
        newPrice := new(big.Int).SetBytes(log.Data)

        // Check all positions that might become liquidatable
        positions := b.getPositionsForAsset(log.Address)

        for _, pos := range positions {
            newHealth := calculateHealthWithPrice(pos, newPrice)
            if newHealth.Cmp(big.NewInt(1e18)) < 0 {
                b.attemptLiquidation(ctx, pos)
            }
        }
    }
}
```

**Key Insight**: Monitor the mempool for pending transactions that could create opportunities. For competitive operations like liquidations, use Flashbots bundles to backrun target transactions.

---

### Pitfall 5: The WebSocket Instability Trap

**Real Incident Report**: An event indexer used WebSocket subscriptions for real-time updates. Random disconnections weren't properly handled, causing hours of missed events. The service showed "connected" but subscriptions had silently died.

**The Anti-Pattern**:
```go
// DANGEROUS: No reconnection or heartbeat logic
func watchEvents(ctx context.Context, client *ethclient.Client) {
    logs := make(chan types.Log)
    sub, _ := client.SubscribeFilterLogs(ctx, ethereum.FilterQuery{}, logs)

    // If connection drops, this silently stops receiving
    for log := range logs {
        processLog(log)
    }
}
```

**The Better Approach**:
```go
type ResilientSubscriber struct {
    endpoints       []string
    currentEndpoint int
    subscription    ethereum.Subscription
    logs            chan types.Log
    reconnectDelay  time.Duration
    maxDelay        time.Duration
    lastBlockSeen   atomic.Uint64
    filter          ethereum.FilterQuery
    mu              sync.Mutex
}

func NewResilientSubscriber(endpoints []string, filter ethereum.FilterQuery) *ResilientSubscriber {
    return &ResilientSubscriber{
        endpoints:      endpoints,
        logs:          make(chan types.Log, 1000),
        reconnectDelay: time.Second,
        maxDelay:       time.Minute,
        filter:        filter,
    }
}

func (s *ResilientSubscriber) Start(ctx context.Context) (<-chan types.Log, error) {
    // Initial connection
    if err := s.connect(ctx); err != nil {
        return nil, err
    }

    // Start heartbeat monitor
    go s.heartbeatMonitor(ctx)

    // Start reconnection handler
    go s.reconnectionLoop(ctx)

    return s.logs, nil
}

func (s *ResilientSubscriber) connect(ctx context.Context) error {
    s.mu.Lock()
    defer s.mu.Unlock()

    // Close existing subscription
    if s.subscription != nil {
        s.subscription.Unsubscribe()
    }

    // Try endpoints in round-robin
    var lastErr error
    for i := 0; i < len(s.endpoints); i++ {
        endpoint := s.endpoints[(s.currentEndpoint+i)%len(s.endpoints)]

        client, err := ethclient.DialContext(ctx, endpoint)
        if err != nil {
            lastErr = err
            continue
        }

        // Update filter to start from last seen block
        filter := s.filter
        if lastBlock := s.lastBlockSeen.Load(); lastBlock > 0 {
            filter.FromBlock = big.NewInt(int64(lastBlock + 1))
        }

        internalLogs := make(chan types.Log, 100)
        sub, err := client.SubscribeFilterLogs(ctx, filter, internalLogs)
        if err != nil {
            client.Close()
            lastErr = err
            continue
        }

        s.subscription = sub
        s.currentEndpoint = (s.currentEndpoint + i) % len(s.endpoints)

        // Forward logs to output channel
        go s.forwardLogs(ctx, internalLogs, sub)

        log.Printf("Connected to %s", endpoint)
        return nil
    }

    return fmt.Errorf("all endpoints failed: %w", lastErr)
}

func (s *ResilientSubscriber) forwardLogs(ctx context.Context, internalLogs <-chan types.Log, sub ethereum.Subscription) {
    for {
        select {
        case <-ctx.Done():
            return
        case err := <-sub.Err():
            if err != nil {
                log.Printf("Subscription error: %v", err)
            }
            return
        case log := <-internalLogs:
            // Track last block seen
            s.lastBlockSeen.Store(log.BlockNumber)

            select {
            case s.logs <- log:
            default:
                log.Printf("Warning: log channel full, dropping log")
            }
        }
    }
}

func (s *ResilientSubscriber) heartbeatMonitor(ctx context.Context) {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    var lastBlockTime time.Time
    var lastBlock uint64

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            currentBlock := s.lastBlockSeen.Load()

            if currentBlock == lastBlock && !lastBlockTime.IsZero() {
                // No new blocks for 30 seconds - might be disconnected
                if time.Since(lastBlockTime) > 2*time.Minute {
                    log.Println("No new blocks for 2 minutes, triggering reconnect")
                    s.triggerReconnect()
                }
            } else {
                lastBlock = currentBlock
                lastBlockTime = time.Now()
            }
        }
    }
}

func (s *ResilientSubscriber) triggerReconnect() {
    s.mu.Lock()
    if s.subscription != nil {
        s.subscription.Unsubscribe()
        s.subscription = nil
    }
    s.mu.Unlock()
}

func (s *ResilientSubscriber) reconnectionLoop(ctx context.Context) {
    delay := s.reconnectDelay

    for {
        select {
        case <-ctx.Done():
            return
        default:
        }

        s.mu.Lock()
        needsReconnect := s.subscription == nil
        s.mu.Unlock()

        if needsReconnect {
            log.Printf("Attempting reconnection in %v", delay)
            time.Sleep(delay)

            if err := s.connect(ctx); err != nil {
                log.Printf("Reconnection failed: %v", err)
                delay = min(delay*2, s.maxDelay) // Exponential backoff
            } else {
                delay = s.reconnectDelay // Reset delay on success

                // Backfill any missed events
                s.backfillMissedEvents(ctx)
            }
        } else {
            time.Sleep(5 * time.Second)
        }
    }
}

func (s *ResilientSubscriber) backfillMissedEvents(ctx context.Context) {
    // Query logs from last seen block to current
    lastBlock := s.lastBlockSeen.Load()
    if lastBlock == 0 {
        return
    }

    filter := s.filter
    filter.FromBlock = big.NewInt(int64(lastBlock))
    filter.ToBlock = nil

    client, _ := ethclient.Dial(s.endpoints[s.currentEndpoint])
    logs, err := client.FilterLogs(ctx, filter)
    if err != nil {
        log.Printf("Backfill failed: %v", err)
        return
    }

    for _, l := range logs {
        select {
        case s.logs <- l:
        default:
        }
    }

    log.Printf("Backfilled %d logs from block %d", len(logs), lastBlock)
}
```

**Key Insight**: WebSocket subscriptions will fail - plan for it. Implement heartbeat monitoring, automatic reconnection with exponential backoff, and backfill logic to catch missed events.

---

### Quick Reference: Web3 Infrastructure Pitfalls

| Pitfall | Impact | Prevention |
|---------|--------|------------|
| Single IPFS gateway | Content unavailable during outages | Multiple gateways + local node |
| Graph indexer dependency | Stale data, wrong decisions | Check sync status, RPC fallback |
| No node sync verification | Trading on stale state | Compare block heights across nodes |
| Missing mempool monitoring | Front-run by competitors | Subscribe to pending transactions |
| WebSocket without heartbeat | Silent disconnections | Heartbeat + auto-reconnect + backfill |

---

### Junior → FAANG: Production Pitfalls in Web3 Infrastructure

Web3 infrastructure production pitfalls follow predictable patterns that you can learn to avoid before your first production deployment. The most common pitfall for junior engineers is treating a third-party RPC provider as if it were an always-available, unlimited-throughput data source. In practice, providers have rate limits (typically 25-100 requests per second per API key on free tiers), occasional service disruptions, and response-time variability that can blow through any reasonable timeout.

The node sync pitfall is particularly subtle: a node can be "running" (the process is alive, responding to RPC calls) but out of sync (not processing new blocks). This happens when the node loses all its peers, when the consensus client is misconfigured post-Merge, or when the node's disk is full and block processing has stalled. Your health check for a node must verify both that the RPC is responding and that the returned block number is recent (within a few blocks of the expected chain head based on an external reference).

The event processing gap pitfall occurs when the event indexer restarts and re-processes events from a checkpoint that is behind the actual last-processed event. This can happen if the checkpoint is written to the database after the events are processed (so a crash between processing and checkpoint-writing loses the checkpoint) or if the checkpoint is written in a separate transaction from the event data (so a crash between the two commits leaves them inconsistent). The correct pattern is to write the events and the checkpoint in the same database transaction, atomically.

Interview entry point: describe the symptoms of a "stuck" event indexer and how you would diagnose it. The symptoms are: the indexer's lag metric increases monotonically, new events from on-chain activity are not appearing in your application's data, and the indexer process is running without errors. The diagnosis steps: check the indexer's last processed block number against the chain head, check whether `eth_getLogs` calls are succeeding (they may be timing out or hitting rate limits), check whether database write operations are completing (they may be blocked on a lock or slowed by disk pressure), and check the indexer's goroutine stack dump (using `pprof`) to identify where it is blocked.

### Senior @ FAANG: Systemic Web3 Infrastructure Failure Prevention

At staff level, Web3 infrastructure failures are organizational learning opportunities. Each significant failure should produce a post-mortem that identifies the root cause, the contributing factors, and the systemic changes needed to prevent recurrence. A post-mortem culture that treats failures as learning events rather than accountability events produces better long-term reliability outcomes.

The most systemic infrastructure failure pattern in Web3 is single-point-of-failure dependency: one RPC provider, one indexer process, one database with no read replica. These single points of failure are predictable and preventable, but they often persist because eliminating them requires upfront investment that is deprioritized when the system is working. Staff engineers who own infrastructure reliability must advocate for eliminating single points of failure before the failures occur, using the case studies of other organizations' failures as evidence for the investment.

RPC provider terms of service compliance is an overlooked infrastructure pitfall. Many RPC providers' terms of service prohibit reselling or redistribution of their RPC access, rate-limiting specific methods (like `debug_traceTransaction`), or using the service for transaction frontrunning. A company that builds a product on top of a provider's API without reading and complying with the ToS may find their access revoked without warning. Staff engineers must review provider ToS before building production systems on their infrastructure and must have a migration plan for any provider that changes their ToS.

The "thundering herd" failure mode in Web3 infrastructure occurs when a significant blockchain event (popular NFT mint, major market move, anticipated hard fork) triggers a simultaneous surge in RPC demand from all applications. If the infrastructure does not have sufficient capacity headroom or request queuing, the surge causes cascading timeouts and failures. Staff engineers who have experienced this failure mode implement: application-level request queuing with defined priorities, rate limiting that prevents any single consumer from monopolizing shared RPC capacity, and auto-scaling policies that add node capacity in response to RPC demand increase.

Dependency version upgrade failures are a recurring infrastructure pitfall. go-ethereum updates frequently and occasionally introduces breaking changes in its RPC output format, event log encoding, or internal package structure. An application that depends on undocumented behavior in the go-ethereum output may break silently after a dependency upgrade. Staff engineers maintain a comprehensive integration test suite that runs against a real Ethereum node after every dependency upgrade, and they practice the discipline of reading go-ethereum changelogs before upgrading.

Bar-raiser signals: designing a chaos engineering program for Web3 infrastructure (periodically injecting failures at each component: node failures, RPC timeouts, database failures, indexer crashes) and verifying that the system's monitoring, alerting, and automatic failover respond correctly to each failure type, or explaining the specific failure mode that caused Binance Smart Chain to pause in 2022 (validators failed to reach consensus on block finalization due to a misconfiguration in the cross-chain communication mechanism, which halted block production). These deep operational case studies reveal the kind of failure analysis that principal engineers conduct.

---
