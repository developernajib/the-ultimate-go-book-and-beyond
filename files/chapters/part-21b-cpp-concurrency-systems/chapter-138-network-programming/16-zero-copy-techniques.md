## Zero-Copy Techniques

"Zero-copy" is a marketing term -- there is always *some* copy somewhere (DMA, NIC ring buffer). What matters is eliminating *user/kernel* copies and *kernel/kernel* copies that the CPU performs synchronously. On a 100 GbE link a `memcpy` is a real bottleneck, at 100 Gbps, a single core cannot copy data fast enough to saturate the wire. This chapter covers the Linux toolbox.

### 1. sendfile(2) -- file -> socket

The classic zero-copy primitive (Linux 2.2 for in-kernel send, 2.4 for socket targets). The kernel pulls pages from the page cache straight into the NIC via DMA, user space never touches the bytes.

```cpp
off_t off = 0;
ssize_t total = 0;
while (total < size) {
  ssize_t n = ::sendfile(sock_fd, file_fd, &off, size - total);
  if (n > 0) { total += n; continue; }
  if (n < 0 && errno == EINTR) continue;
  if (n < 0 && errno == EAGAIN) { wait_writable(sock_fd); continue; }
  throw std::system_error(errno, std::system_category(), "sendfile");
}
```

`sendfile` requires:
- Source is a regular file or shmem-backed fd (kernels >= 2.6.33 lifted "file -> file" to splice).
- Destination is a stream socket (TCP, UDS).
- Caller cannot inject application-layer headers in the same syscall. Use `TCP_CORK` + `write` for headers + `sendfile` for body.

Throughput numbers (single core, 25 GbE NIC, 1 MiB transfer): `read+write` ~ 7 Gbps, `sendfile` ~ 22 Gbps, `splice` similar. Real number depends on page-cache hit rate, cold reads collapse to disk speed.

### 2. splice(2) -- pipe-mediated kernel transfer

`splice` moves data between two fds via a kernel pipe buffer without copying through user space. Required when neither end is a regular file (e.g., socket -> socket proxy).

```cpp
int p[2];
::pipe2(p, O_NONBLOCK | O_CLOEXEC);
for (;;) {
  ssize_t in = ::splice(client_fd, nullptr, p[1], nullptr,
                        65536, SPLICE_F_MOVE | SPLICE_F_NONBLOCK);
  if (in <= 0) break;
  ssize_t out = 0;
  while (out < in) {
    ssize_t n = ::splice(p[0], nullptr, upstream_fd, nullptr,
                         in - out, SPLICE_F_MOVE | SPLICE_F_NONBLOCK);
    if (n <= 0) break;
    out += n;
  }
}
```

This is the proxy fast-path used by HAProxy's `option splice-auto`, by `linkerd2-proxy` (when the protocol does not need inspection), and by the kernel's TLS-offload fallback path. Limitations:

- One direction at a time per pipe, bidirectional proxy needs two pipe pairs.
- `SPLICE_F_MOVE` is a hint, kernels often copy anyway for sockets.
- `splice` between two sockets without an intermediate pipe was added later (`vmsplice` for `iov_iter` work).

### 3. vmsplice(2) -- user pages -> pipe

`vmsplice` "gifts" user pages into a pipe. With `SPLICE_F_GIFT` you transfer ownership, the kernel may keep referencing the pages, so you must not write them again until the splice completes. Used to chain user-generated data into a `splice` pipeline.

```cpp
iovec iov{.iov_base = buf, .iov_len = len};
::vmsplice(p[1], &iov, 1, SPLICE_F_GIFT);
::splice(p[0], nullptr, sock_fd, nullptr, len, 0);
```

Practical use is narrow, most teams skip `vmsplice` because the lifetime semantics are subtle and a regular `send` with `MSG_ZEROCOPY` is easier.

### 4. MSG_ZEROCOPY -- the modern user-buffer path

`MSG_ZEROCOPY` (Linux 4.14, commit `52267790ef52`) lets `send`/`sendmsg` keep references to user pages and DMA from them directly. Notification of "you can reuse the buffer now" comes back via the socket error queue.

Setup:

```cpp
int one = 1;
setsockopt(sock_fd, SOL_SOCKET, SO_ZEROCOPY, &one, sizeof(one));
```

Send:

```cpp
ssize_t n = ::send(sock_fd, buf, len, MSG_ZEROCOPY);
// buf is "in flight" - do not overwrite until completion arrives.
```

Read completion notifications:

```cpp
msghdr msg{};
char ctrl[256];
msg.msg_control = ctrl;
msg.msg_controllen = sizeof(ctrl);
::recvmsg(sock_fd, &msg, MSG_ERRQUEUE);
for (cmsghdr* c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c)) {
  if (c->cmsg_level == SOL_IP && c->cmsg_type == IP_RECVERR) {
    auto* serr = (sock_extended_err*)CMSG_DATA(c);
    if (serr->ee_origin == SO_EE_ORIGIN_ZEROCOPY) {
      // serr->ee_info..ee_data is the range of completed sends
      release_pages(serr->ee_info, serr->ee_data);
    }
  }
}
```

Wins kick in for sends > ~10 KiB, below that, the bookkeeping (cmsg parsing, kernel reference counts) costs more than the saved copy. Facebook's ZSTD-compressed log shipper, Cloudflare's HTTP/2 server, and Netflix's video edge use `MSG_ZEROCOPY` for large responses.

### 5. TCP_ZEROCOPY_RECEIVE -- the receive side

`TCP_ZEROCOPY_RECEIVE` (Linux 4.18) maps received TCP data directly into user-space via mmap. Required: aligned, page-sized payload boundaries -- works for bulk RPC transports, fails for typical text protocols. Used by gRPC's `tcp_zerocopy_receive` experiment and by some custom RPC stacks at Google.

```cpp
tcp_zerocopy_receive zc{};
zc.address = (uintptr_t)mmap_region;
zc.length  = region_size;
socklen_t len = sizeof(zc);
getsockopt(fd, IPPROTO_TCP, TCP_ZEROCOPY_RECEIVE, &zc, &len);
// zc.length is bytes mapped - zc.recv_skip_hint is bytes that fell
// back to copy (must be drained with normal recv before next call).
```

### 6. io_uring fixed buffers and SEND_ZC

Two relevant io_uring features:

- `IORING_REGISTER_BUFFERS` + `IORING_OP_READ_FIXED` / `WRITE_FIXED` -- pin pages once, eliminate per-op `get_user_pages`. Not zero-copy in the strict sense, but kills the per-op overhead that limits small-IO IOPS.
- `IORING_OP_SEND_ZC` (Linux 6.0, commit `06a5464be84e`) -- io_uring's analog of `MSG_ZEROCOPY`. Completion arrives as a regular CQE plus a "notification CQE" once the buffer can be reused. No socket error queue gymnastics.

```cpp
auto* sqe = io_uring_get_sqe(ring);
io_uring_prep_send_zc(sqe, fd, buf, len, 0, 0);
sqe->user_data = reinterpret_cast<__u64>(awaiter);
// awaiter receives two CQEs: send result, then F_NOTIF when buf is free
```

Pair with fixed buffers (`IORING_OP_SEND_ZC_FIXED`) for full zero-touch hot path.

### 7. AF_XDP -- bypassing the socket stack

`AF_XDP` (Linux 4.18) is not "zero-copy on a socket", it is a different stack. You bind a UMEM (user-allocated memory pool) to a NIC queue, and packets DMA straight into your buffers. The kernel networking stack is bypassed, you implement TCP/UDP yourself or use a userspace stack (mTCP, F-Stack).

Skeleton:

```cpp
xsk_umem_config ucfg{
  .fill_size = 4096,
  .comp_size = 4096,
  .frame_size = 4096,
  .frame_headroom = 0,
  .flags = 0,
};
void* umem_area = std::aligned_alloc(getpagesize(), 4096 * 4096);
xsk_umem* umem = nullptr;
xsk_ring_prod fill;
xsk_ring_cons comp;
xsk_umem__create(&umem, umem_area, 4096 * 4096, &fill, &comp, &ucfg);

xsk_socket_config scfg{
  .rx_size = 2048, .tx_size = 2048,
  .libxdp_flags = 0,
  .xdp_flags = XDP_FLAGS_DRV_MODE,
  .bind_flags = XDP_ZEROCOPY,
};
xsk_socket* xsk = nullptr;
xsk_ring_cons rx; xsk_ring_prod tx;
xsk_socket__create(&xsk, "eth0", /*queue=*/0, umem, &rx, &tx, &scfg);
```

Then you poll the rings directly. Peak performance: 30+ Mpps per core on a 100 GbE NIC. Used by Cilium service mesh fast-path, Cloudflare's `udpgrm`-style load balancers, and modern QUIC servers wanting line-rate UDP. NIC must support `XDP_ZEROCOPY` mode, otherwise it falls back to copy mode (still faster than AF_PACKET, not literal zero-copy).

### 8. kTLS -- offloading TLS framing to the kernel

`kTLS` (Linux 4.13 send, 4.17 receive) lets the kernel encrypt/decrypt TLS records inline, so `sendfile` works on a TLS connection -- the kernel applies AES-GCM as it DMAs file pages out. Requires NIC TLS offload for true zero-copy, otherwise the CPU still does AES (but in kernel, no copy across the user/kernel boundary).

```cpp
setsockopt(fd, SOL_TCP, TCP_ULP, "tls", 3);
tls12_crypto_info_aes_gcm_128 info{};
info.info.version = TLS_1_2_VERSION;
info.info.cipher_type = TLS_CIPHER_AES_GCM_128;
// fill iv, key, salt, rec_seq from your finished handshake
setsockopt(fd, SOL_TLS, TLS_TX, &info, sizeof(info));
// now sendfile(fd, ...) emits TLS records
```

NGINX, Netflix's media edge (FreeBSD kTLS variant, the famous "200 Gbps from one box" blog), and HAProxy 2.5+ support kTLS.

### 9. Benchmark crib sheet

| Technique | CPU savings | Complexity | When it wins |
|---------------------|-----------------------|------------|-------------------------------------------|
| `sendfile` | huge (no user copy) | trivial | static-file servers, video |
| `splice` proxy | large | medium | TCP proxies that do not parse payload |
| `MSG_ZEROCOPY` | 30-50% on >10 KiB | medium | bulk RPC, log shippers |
| `TCP_ZEROCOPY_RECEIVE` | 20-40% | high | aligned, page-sized RPC |
| io_uring `SEND_ZC` | comparable to MSG_ZC | medium | already on io_uring |
| AF_XDP | order of magnitude | very high | line-rate UDP, custom stacks |
| kTLS + sendfile | huge for TLS bulk | medium | TLS file servers, video edge |

### 10. Common pitfalls

- "Zero-copy" with small payloads is slower. Benchmark your workload.
- `MSG_ZEROCOPY` requires you to keep buffers stable until notification -- you need a slab allocator with delayed free, or a `std::shared_ptr` strategy. Easy to introduce use-after-free here.
- `sendfile` with `SO_KEEPALIVE` and a stalled peer holds page-cache references. Combine with `TCP_USER_TIMEOUT`.
- AF_XDP bypasses iptables, conntrack, traffic shaping. You re-implement what you bypass or accept its absence.
- kTLS does not interoperate with TLS 1.3 0-RTT or post-handshake auth on older kernels (5.x). Check kernel changelog before enabling in production.

> Senior @ FAANG: pick exactly one zero-copy technique per data path and own it. The temptation is to layer all of them, you end up with code that is harder to reason about than the `read+write` it replaced. Cloudflare's TLS server uses kTLS + sendfile, period. Netflix's video edge uses kTLS + sendfile + NIC offload. Both are deliberately boring.

