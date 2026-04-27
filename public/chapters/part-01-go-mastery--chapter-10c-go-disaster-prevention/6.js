export default `## 10C.5 Nil Pointer Dereference

A nil pointer dereference is one of the most common panics in Go programs. It happens when you try to access a field or call a method on a pointer that is \`nil\` - meaning it does not point to any allocated memory. Go does not have optional types or null safety like some other languages, so any pointer can be nil, and the compiler will not warn you. You must always check pointers before accessing their fields, especially when working with functions that return pointers (where \`nil\` often signals "not found").

\`\`\`go
package main

import "fmt"

type User struct {
    Name    string
    Address *Address
}

type Address struct {
    City string
}

func GetUser(id int) *User {
    if id == 0 {
        return nil // user not found
    }
    return &User{Name: "Alice"} // no Address set
}

func main() {
    // DISASTER 1: nil receiver dereference
    user := GetUser(0)
    // fmt.Println(user.Name) // panic: nil pointer dereference

    // FIX 1: Always check
    if user == nil {
        fmt.Println("user not found")
        return
    }

    // DISASTER 2: chained nil dereference
    user2 := GetUser(1)
    // fmt.Println(user2.Address.City) // panic! Address is nil

    // FIX 2: Check each pointer in chain
    if user2.Address != nil {
        fmt.Println(user2.Address.City)
    }

    // FIX 3: Use a method with nil receiver check (idiomatic Go)
    fmt.Println(user2.GetCity()) // returns "" safely
}

// Nil-safe method: Go methods can be called on nil receivers
func (u *User) GetCity() string {
    if u == nil || u.Address == nil {
        return ""
    }
    return u.Address.City
}

// TRAP: Nil map READ is safe, nil map WRITE panics
func nilMapTrap() {
    var m map[string]int // nil map

    // READ: safe, returns zero value
    v := m["key"] // v = 0, no panic
    fmt.Println(v)

    // WRITE: PANICS
    // m["key"] = 1 // panic: assignment to entry in nil map

    // FIX: Initialize the map before writing
    m = make(map[string]int)
    m["key"] = 1 // safe
}
\`\`\`

---
`;
