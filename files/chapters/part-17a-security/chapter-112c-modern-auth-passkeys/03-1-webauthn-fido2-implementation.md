## 112C.2 WebAuthn / FIDO2 Implementation

WebAuthn replaces passwords with public-key cryptography: during registration the authenticator (platform biometric or hardware key) generates a key pair and returns the public key to the relying party (the Go server), which stores it alongside a credential ID and the user handle. During authentication the server sends a random challenge, the authenticator signs it with the credential's private key (which never leaves the device), and the Go server verifies the signature against the stored public key. This architecture is inherently phishing-resistant because the authenticator cryptographically binds the key pair to the relying party's origin (`rpID`), so a fake site cannot receive valid assertions even if it intercepts the challenge.

```go
package passkeys

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

// WebAuthnService handles passkey registration and authentication
type WebAuthnService struct {
	mu           sync.RWMutex
	webAuthn     *webauthn.WebAuthn
	sessionStore map[string]*webauthn.SessionData
	credStore    CredentialStore
}

// CredentialStore interface for persisting WebAuthn credentials
type CredentialStore interface {
	SaveCredential(userID string, cred *StoredCredential) error
	GetCredentials(userID string) ([]*StoredCredential, error)
	GetCredentialByID(credentialID []byte) (*StoredCredential, error)
	UpdateCredential(cred *StoredCredential) error
	DeleteCredential(userID string, credentialID []byte) error
}

// StoredCredential represents a persisted WebAuthn credential
type StoredCredential struct {
	ID              []byte    `json:"id"`
	UserID          string    `json:"userId"`
	PublicKey       []byte    `json:"publicKey"`
	AttestationType string    `json:"attestationType"`
	Transport       []string  `json:"transport"`
	Flags           CredFlags `json:"flags"`
	Authenticator   AuthInfo  `json:"authenticator"`
	CreatedAt       time.Time `json:"createdAt"`
	LastUsed        time.Time `json:"lastUsed"`
	Name            string    `json:"name"` // User-friendly name, e.g. "MacBook Touch ID"
}

// CredFlags represents authenticator flags
type CredFlags struct {
	UserPresent    bool `json:"up"`
	UserVerified   bool `json:"uv"`
	BackupEligible bool `json:"be"`
	BackupState    bool `json:"bs"`
}

// AuthInfo represents authenticator information
type AuthInfo struct {
	AAGUID       []byte `json:"aaguid"`
	SignCount    uint32 `json:"signCount"`
	CloneWarning bool   `json:"cloneWarning"`
}

// WebAuthnUser implements the webauthn.User interface
type WebAuthnUser struct {
	ID          []byte
	Name        string
	DisplayName string
	Credentials []webauthn.Credential
}

func (u *WebAuthnUser) WebAuthnID() []byte                         { return u.ID }
func (u *WebAuthnUser) WebAuthnName() string                       { return u.Name }
func (u *WebAuthnUser) WebAuthnDisplayName() string                { return u.DisplayName }
func (u *WebAuthnUser) WebAuthnCredentials() []webauthn.Credential { return u.Credentials }

// NewWebAuthnService creates a new WebAuthn service
func NewWebAuthnService(
	rpID string,
	rpName string,
	rpOrigins []string,
	credStore CredentialStore,
) (*WebAuthnService, error) {
	wauthn, err := webauthn.New(&webauthn.Config{
		RPDisplayName: rpName,
		RPID:          rpID,
		RPOrigins:     rpOrigins,
		// Require discoverable credentials and user verification for
		// passkeys. No attachment preference: both platform
		// authenticators (Touch ID) and roaming keys (YubiKey) work
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			RequireResidentKey: protocol.ResidentKeyRequired(),
			ResidentKey:        protocol.ResidentKeyRequirementRequired,
			UserVerification:   protocol.VerificationRequired,
		},
		AttestationPreference: protocol.PreferNoAttestation,
		Timeouts: webauthn.TimeoutsConfig{
			Login: webauthn.TimeoutConfig{
				Enforce:    true,
				Timeout:    60 * time.Second,
				TimeoutUVD: 60 * time.Second,
			},
			Registration: webauthn.TimeoutConfig{
				Enforce:    true,
				Timeout:    60 * time.Second,
				TimeoutUVD: 60 * time.Second,
			},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("webauthn init failed: %w", err)
	}

	return &WebAuthnService{
		webAuthn:     wauthn,
		sessionStore: make(map[string]*webauthn.SessionData),
		credStore:    credStore,
	}, nil
}

// BeginRegistration starts the passkey registration ceremony
func (s *WebAuthnService) BeginRegistration(
	userID, username, displayName string,
) (*protocol.CredentialCreation, string, error) {
	// Load existing credentials to prevent re-registration
	existingCreds, err := s.credStore.GetCredentials(userID)
	if err != nil {
		return nil, "", fmt.Errorf("failed to load credentials: %w", err)
	}

	// Convert to webauthn credentials
	excludeList := make([]webauthn.Credential, 0, len(existingCreds))
	for _, cred := range existingCreds {
		excludeList = append(excludeList, webauthn.Credential{
			ID: cred.ID,
		})
	}

	user := &WebAuthnUser{
		ID:          []byte(userID),
		Name:        username,
		DisplayName: displayName,
		Credentials: excludeList,
	}

	// Registration options. WithExclusions takes credential
	// descriptors so the browser skips already-registered authenticators
	exclusions := make([]protocol.CredentialDescriptor, 0, len(excludeList))
	for _, c := range excludeList {
		exclusions = append(exclusions, c.Descriptor())
	}

	opts := []webauthn.RegistrationOption{
		webauthn.WithExclusions(exclusions),
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			RequireResidentKey: protocol.ResidentKeyRequired(),
			ResidentKey:        protocol.ResidentKeyRequirementRequired,
			UserVerification:   protocol.VerificationRequired,
		}),
	}

	options, sessionData, err := s.webAuthn.BeginRegistration(user, opts...)
	if err != nil {
		return nil, "", fmt.Errorf("begin registration failed: %w", err)
	}

	// Store session data
	sessionKey := generateSessionKey()
	s.mu.Lock()
	s.sessionStore[sessionKey] = sessionData
	s.mu.Unlock()

	return options, sessionKey, nil
}

// FinishRegistration completes the passkey registration
func (s *WebAuthnService) FinishRegistration(
	userID, username, displayName string,
	sessionKey string,
	response *http.Request,
) (*StoredCredential, error) {
	// Retrieve session data
	s.mu.Lock()
	sessionData, exists := s.sessionStore[sessionKey]
	if exists {
		delete(s.sessionStore, sessionKey)
	}
	s.mu.Unlock()

	if !exists {
		return nil, errors.New("invalid or expired session")
	}

	user := &WebAuthnUser{
		ID:          []byte(userID),
		Name:        username,
		DisplayName: displayName,
	}

	credential, err := s.webAuthn.FinishRegistration(user, *sessionData, response)
	if err != nil {
		return nil, fmt.Errorf("registration verification failed: %w", err)
	}

	// Store credential
	stored := &StoredCredential{
		ID:              credential.ID,
		UserID:          userID,
		PublicKey:       credential.PublicKey,
		AttestationType: credential.AttestationType,
		Flags: CredFlags{
			UserPresent:    credential.Flags.UserPresent,
			UserVerified:   credential.Flags.UserVerified,
			BackupEligible: credential.Flags.BackupEligible,
			BackupState:    credential.Flags.BackupState,
		},
		Authenticator: AuthInfo{
			AAGUID:    credential.Authenticator.AAGUID,
			SignCount: credential.Authenticator.SignCount,
		},
		CreatedAt: time.Now(),
		LastUsed:  time.Now(),
		Name:      "Passkey",
	}

	if err := s.credStore.SaveCredential(userID, stored); err != nil {
		return nil, fmt.Errorf("failed to save credential: %w", err)
	}

	return stored, nil
}

// BeginAuthentication starts the passkey authentication ceremony
func (s *WebAuthnService) BeginAuthentication(userID string) (*protocol.CredentialAssertion, string, error) {
	creds, err := s.credStore.GetCredentials(userID)
	if err != nil {
		return nil, "", fmt.Errorf("failed to load credentials: %w", err)
	}

	if len(creds) == 0 {
		return nil, "", fmt.Errorf("no passkeys registered for user")
	}

	// Convert stored credentials to webauthn format
	webAuthnCreds := make([]webauthn.Credential, 0, len(creds))
	for _, cred := range creds {
		webAuthnCreds = append(webAuthnCreds, webauthn.Credential{
			ID:        cred.ID,
			PublicKey: cred.PublicKey,
			Authenticator: webauthn.Authenticator{
				AAGUID:    cred.Authenticator.AAGUID,
				SignCount: cred.Authenticator.SignCount,
			},
		})
	}

	user := &WebAuthnUser{
		ID:          []byte(userID),
		Credentials: webAuthnCreds,
	}

	options, sessionData, err := s.webAuthn.BeginLogin(user)
	if err != nil {
		return nil, "", fmt.Errorf("begin login failed: %w", err)
	}

	sessionKey := generateSessionKey()
	s.mu.Lock()
	s.sessionStore[sessionKey] = sessionData
	s.mu.Unlock()

	return options, sessionKey, nil
}

// BeginDiscoverableAuthentication starts passwordless authentication
// (no username required - uses resident/discoverable credentials)
func (s *WebAuthnService) BeginDiscoverableAuthentication() (*protocol.CredentialAssertion, string, error) {
	options, sessionData, err := s.webAuthn.BeginDiscoverableLogin()
	if err != nil {
		return nil, "", fmt.Errorf("begin discoverable login failed: %w", err)
	}

	sessionKey := generateSessionKey()
	s.mu.Lock()
	s.sessionStore[sessionKey] = sessionData
	s.mu.Unlock()

	return options, sessionKey, nil
}

// FinishAuthentication completes passkey authentication
func (s *WebAuthnService) FinishAuthentication(
	userID string,
	sessionKey string,
	response *http.Request,
) (*StoredCredential, error) {
	s.mu.Lock()
	sessionData, exists := s.sessionStore[sessionKey]
	if exists {
		delete(s.sessionStore, sessionKey)
	}
	s.mu.Unlock()

	if !exists {
		return nil, errors.New("invalid or expired session")
	}

	creds, err := s.credStore.GetCredentials(userID)
	if err != nil {
		return nil, fmt.Errorf("failed to load credentials: %w", err)
	}

	webAuthnCreds := make([]webauthn.Credential, 0, len(creds))
	for _, cred := range creds {
		webAuthnCreds = append(webAuthnCreds, webauthn.Credential{
			ID:        cred.ID,
			PublicKey: cred.PublicKey,
			Authenticator: webauthn.Authenticator{
				AAGUID:    cred.Authenticator.AAGUID,
				SignCount: cred.Authenticator.SignCount,
			},
		})
	}

	user := &WebAuthnUser{
		ID:          []byte(userID),
		Credentials: webAuthnCreds,
	}

	credential, err := s.webAuthn.FinishLogin(user, *sessionData, response)
	if err != nil {
		return nil, fmt.Errorf("authentication failed: %w", err)
	}

	// Update sign count (clone detection)
	var usedCred *StoredCredential
	for _, c := range creds {
		if string(c.ID) == string(credential.ID) {
			usedCred = c
			break
		}
	}

	if usedCred == nil {
		return nil, errors.New("credential not found after login")
	}

	// Check for cloned authenticator
	if credential.Authenticator.CloneWarning {
		return nil, errors.New("authenticator clone detected: security alert")
	}

	// Update sign count and last used
	usedCred.Authenticator.SignCount = credential.Authenticator.SignCount
	usedCred.LastUsed = time.Now()
	if err := s.credStore.UpdateCredential(usedCred); err != nil {
		return nil, fmt.Errorf("failed to update credential: %w", err)
	}

	return usedCred, nil
}

// FinishDiscoverableAuthentication completes passwordless authentication
func (s *WebAuthnService) FinishDiscoverableAuthentication(
	sessionKey string,
	response *http.Request,
) (string, *StoredCredential, error) {
	s.mu.Lock()
	sessionData, exists := s.sessionStore[sessionKey]
	if exists {
		delete(s.sessionStore, sessionKey)
	}
	s.mu.Unlock()

	if !exists {
		return "", nil, errors.New("invalid or expired session")
	}

	// Discoverable login handler looks up user by credential ID
	var userID string
	var finalCred *StoredCredential

	credential, err := s.webAuthn.FinishDiscoverableLogin(
		func(rawID, userHandle []byte) (webauthn.User, error) {
			// Look up credential by ID
			stored, err := s.credStore.GetCredentialByID(rawID)
			if err != nil {
				return nil, fmt.Errorf("credential not found: %w", err)
			}

			userID = stored.UserID
			finalCred = stored

			// Load all credentials for this user
			creds, err := s.credStore.GetCredentials(stored.UserID)
			if err != nil {
				return nil, err
			}

			webAuthnCreds := make([]webauthn.Credential, 0, len(creds))
			for _, c := range creds {
				webAuthnCreds = append(webAuthnCreds, webauthn.Credential{
					ID:        c.ID,
					PublicKey: c.PublicKey,
					Authenticator: webauthn.Authenticator{
						AAGUID:    c.Authenticator.AAGUID,
						SignCount: c.Authenticator.SignCount,
					},
				})
			}

			return &WebAuthnUser{
				ID:          []byte(stored.UserID),
				Credentials: webAuthnCreds,
			}, nil
		},
		*sessionData,
		response,
	)

	if err != nil {
		return "", nil, fmt.Errorf("discoverable authentication failed: %w", err)
	}

	if credential.Authenticator.CloneWarning {
		return "", nil, errors.New("authenticator clone detected")
	}

	if finalCred != nil {
		finalCred.Authenticator.SignCount = credential.Authenticator.SignCount
		finalCred.LastUsed = time.Now()
		s.credStore.UpdateCredential(finalCred)
	}

	return userID, finalCred, nil
}

// HTTP Handlers for WebAuthn

// HandleBeginRegistration handles POST /webauthn/register/begin
func (s *WebAuthnService) HandleBeginRegistration(w http.ResponseWriter, r *http.Request) {
	var req struct {
		UserID      string `json:"userId"`
		Username    string `json:"username"`
		DisplayName string `json:"displayName"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}

	options, sessionKey, err := s.BeginRegistration(req.UserID, req.Username, req.DisplayName)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Store session key in secure cookie
	http.SetCookie(w, &http.Cookie{
		Name:     "webauthn-session",
		Value:    sessionKey,
		Path:     "/",
		MaxAge:   120,
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(options)
}

// HandleFinishRegistration handles POST /webauthn/register/finish
func (s *WebAuthnService) HandleFinishRegistration(w http.ResponseWriter, r *http.Request) {
	// Get session key from cookie
	cookie, err := r.Cookie("webauthn-session")
	if err != nil {
		http.Error(w, "Missing session", http.StatusBadRequest)
		return
	}

	// Get user info from session/JWT
	userID := r.Header.Get("X-User-ID") // In production: from authenticated session
	username := r.Header.Get("X-Username")
	displayName := r.Header.Get("X-Display-Name")

	cred, err := s.FinishRegistration(userID, username, displayName, cookie.Value, r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Clear session cookie
	http.SetCookie(w, &http.Cookie{
		Name:   "webauthn-session",
		Value:  "",
		MaxAge: -1,
	})

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"credentialId": base64.RawURLEncoding.EncodeToString(cred.ID),
		"name":         cred.Name,
		"createdAt":    cred.CreatedAt,
	})
}

func generateSessionKey() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
```

---
