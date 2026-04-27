export default `## 10C.21 init() Function Ordering Surprises

Go's \`init()\` functions run automatically before \`main()\`, and their execution order depends on import order and file naming, both of which can change silently when you add a new file or rearrange imports. If one package's \`init()\` depends on another package's global variable being initialized first, the program may work today but break tomorrow when someone adds a new import. A safer approach is to use \`sync.Once\` for lazy initialization, which guarantees the resource is set up exactly when it is first needed, regardless of package load order.

\`\`\`go
// package main

// TRAP: init() order within a package is determined by declaration order
// init() order ACROSS packages is determined by import order
// This makes init() order fragile and hard to reason about

// ============ pkg/database/db.go ============
// var DB *sql.DB  // initialized by init()
//
// func init() {
//     var err error
//     DB, err = sql.Open("postgres", os.Getenv("DATABASE_URL"))
//     if err != nil {
//         log.Fatal(err) // fatal during init = crash with no recovery
//     }
// }

// ============ pkg/models/user.go ============
// import "pkg/database"
//
// var users = loadUsers() // called during package init
//
// func loadUsers() []User {
//     return database.DB.Query("SELECT * FROM users") // DB might not be initialized yet!
// }

// SAFE ALTERNATIVE: Lazy initialization via Once
// var (
//     dbOnce sync.Once
//     db     *sql.DB
// )
//
// func GetDB() *sql.DB {
//     dbOnce.Do(func() {
//         var err error
//         db, err = sql.Open("postgres", os.Getenv("DATABASE_URL"))
//         if err != nil {
//             panic(err)
//         }
//     })
//     return db
// }
\`\`\`

---
`;
