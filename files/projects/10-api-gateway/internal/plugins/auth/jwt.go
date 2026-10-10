// internal/plugins/auth/jwt.go
package auth

import (
    "context"
    "fmt"
    "net/http"
    "strings"

    "github.com/golang-jwt/jwt/v5"
    "github.com/example/api-gateway/internal/plugin"
)

// JWTAuthPlugin validates JWT tokens
type JWTAuthPlugin struct {
    secret    []byte
    algorithm string
    header    string
    prefix    string
}

func NewJWTAuthPlugin() plugin.Plugin {
    return &JWTAuthPlugin{
        header: "Authorization",
        prefix: "Bearer ",
    }
}

func (p *JWTAuthPlugin) Name() string {
    return "jwt_auth"
}

func (p *JWTAuthPlugin) Priority() int {
    return 100 // Run early
}

func (p *JWTAuthPlugin) Init(config map[string]any) error {
    if secret, ok := config["secret"].(string); ok {
        p.secret = []byte(secret)
    } else {
        return fmt.Errorf("secret is required")
    }

    if alg, ok := config["algorithm"].(string); ok {
        p.algorithm = alg
    } else {
        p.algorithm = "HS256"
    }

    if header, ok := config["header"].(string); ok {
        p.header = header
    }

    if prefix, ok := config["prefix"].(string); ok {
        p.prefix = prefix
    }

    return nil
}

func (p *JWTAuthPlugin) ProcessRequest(ctx context.Context, req *http.Request) (*http.Request, error) {
    // Extract token from header
    authHeader := req.Header.Get(p.header)
    if authHeader == "" {
        return nil, fmt.Errorf("missing authorization header")
    }

    tokenString := strings.TrimPrefix(authHeader, p.prefix)
    if tokenString == authHeader {
        return nil, fmt.Errorf("invalid authorization format")
    }

    // Parse and validate token
    token, err := jwt.Parse(tokenString, func(token *jwt.Token) (any, error) {
        // Verify algorithm
        if token.Method.Alg() != p.algorithm {
            return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
        }
        return p.secret, nil
    })

    if err != nil {
        return nil, fmt.Errorf("invalid token: %w", err)
    }

    if !token.Valid {
        return nil, fmt.Errorf("token is not valid")
    }

    // Add claims to context
    if claims, ok := token.Claims.(jwt.MapClaims); ok {
        ctx = context.WithValue(ctx, "jwt_claims", claims)
        req = req.WithContext(ctx)
    }

    return req, nil
}

func (p *JWTAuthPlugin) ProcessResponse(ctx context.Context, resp *http.Response) (*http.Response, error) {
    return resp, nil
}

func init() {
    plugin.Register("jwt_auth", NewJWTAuthPlugin)
}
