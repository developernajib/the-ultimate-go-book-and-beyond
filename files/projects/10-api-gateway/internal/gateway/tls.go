// internal/gateway/tls.go
package gateway

import (
    "crypto/tls"
    "crypto/x509"
    "fmt"
    "os"
)

// LoadTLSConfig loads TLS configuration
func LoadTLSConfig(config *TLSConfig) (*tls.Config, error) {
    if !config.Enabled {
        return nil, nil
    }

    cert, err := tls.LoadX509KeyPair(config.CertFile, config.KeyFile)
    if err != nil {
        return nil, fmt.Errorf("load certificate: %w", err)
    }

    tlsConfig := &tls.Config{
        Certificates: []tls.Certificate{cert},
        MinVersion:   tls.VersionTLS12,
    }

    // Configure client authentication
    if config.ClientAuth != "" && config.ClientAuth != "none" {
        if config.CACertFile == "" {
            return nil, fmt.Errorf("ca_cert_file required for client auth")
        }

        caCert, err := os.ReadFile(config.CACertFile)
        if err != nil {
            return nil, fmt.Errorf("read CA cert: %w", err)
        }

        caCertPool := x509.NewCertPool()
        caCertPool.AppendCertsFromPEM(caCert)

        tlsConfig.ClientCAs = caCertPool

        switch config.ClientAuth {
        case "request":
            tlsConfig.ClientAuth = tls.RequestClientCert
        case "require":
            tlsConfig.ClientAuth = tls.RequireAndVerifyClientCert
        }
    }

    // Configure TLS version
    if config.MinVersion != "" {
        switch config.MinVersion {
        case "1.2":
            tlsConfig.MinVersion = tls.VersionTLS12
        case "1.3":
            tlsConfig.MinVersion = tls.VersionTLS13
        }
    }

    return tlsConfig, nil
}

// StartTLS starts the server with TLS
func (s *Server) StartTLS(tlsConfig *tls.Config) error {
    s.httpServer.TLSConfig = tlsConfig
    return s.httpServer.ListenAndServeTLS("", "")
}
