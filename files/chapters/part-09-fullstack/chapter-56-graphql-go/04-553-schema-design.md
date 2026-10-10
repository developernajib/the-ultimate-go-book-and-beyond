## 56.3 Schema Design

### Complete Schema Example

A well-designed GraphQL schema serves as the contract between frontend and backend teams, expressing both the available operations and the relationships between types in a self-documenting SDL file. Defining interfaces like `Node` with a required `id` field, and using custom scalars for `DateTime` and `UUID`, makes the schema interoperable with standard GraphQL tooling for code generation and schema stitching. The schema below models a realistic social content domain with queries, mutations, subscriptions, and proper pagination using the Relay cursor connection pattern.

```graphql
# graph/schema.graphqls

# Custom scalars
scalar DateTime
scalar UUID

# Enums
enum UserRole {
  ADMIN
  USER
  GUEST
}

enum OrderStatus {
  PENDING
  CONFIRMED
  SHIPPED
  DELIVERED
  CANCELED
}

enum SortOrder {
  ASC
  DESC
}

# Input types for filtering and pagination
input PaginationInput {
  limit: Int = 20
  offset: Int = 0
}

input UserFilter {
  role: UserRole
  createdAfter: DateTime
  createdBefore: DateTime
  searchTerm: String
}

input ProductFilter {
  categoryId: UUID
  minPrice: Int # Price in cents (minor units)
  maxPrice: Int # Price in cents (minor units)
  inStock: Boolean
}

input OrderFilter {
  status: OrderStatus
  userId: UUID
  createdAfter: DateTime
  createdBefore: DateTime
}

# Connection types for cursor-based pagination
type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
  totalCount: Int!
}

type UserEdge {
  node: User!
  cursor: String!
}

type UserConnection {
  edges: [UserEdge!]!
  pageInfo: PageInfo!
}

type ProductEdge {
  node: Product!
  cursor: String!
}

type ProductConnection {
  edges: [ProductEdge!]!
  pageInfo: PageInfo!
}

# Main types
type User {
  id: UUID!
  email: String!
  name: String!
  role: UserRole!
  avatar: String
  orders(first: Int, after: String): OrderConnection!
  createdAt: DateTime!
  updatedAt: DateTime!
}

type Product {
  id: UUID!
  name: String!
  description: String!
  price: Int! # Price in cents (minor units)
  stock: Int!
  category: Category!
  images: [String!]!
  reviews(first: Int, after: String): ReviewConnection!
  averageRating: Float
  createdAt: DateTime!
  updatedAt: DateTime!
}

type Category {
  id: UUID!
  name: String!
  slug: String!
  parent: Category
  children: [Category!]!
  products(first: Int, after: String, filter: ProductFilter): ProductConnection!
}

type Order {
  id: UUID!
  user: User!
  items: [OrderItem!]!
  status: OrderStatus!
  totalAmount: Int! # Total amount in cents (minor units)
  shippingAddress: Address!
  createdAt: DateTime!
  updatedAt: DateTime!
}

type OrderItem {
  id: UUID!
  product: Product!
  quantity: Int!
  unitPrice: Int! # Unit price in cents (minor units)
  totalPrice: Int! # Total price in cents (minor units)
}

type OrderEdge {
  node: Order!
  cursor: String!
}

type OrderConnection {
  edges: [OrderEdge!]!
  pageInfo: PageInfo!
}

type Review {
  id: UUID!
  user: User!
  product: Product!
  rating: Int!
  comment: String
  createdAt: DateTime!
}

type ReviewEdge {
  node: Review!
  cursor: String!
}

type ReviewConnection {
  edges: [ReviewEdge!]!
  pageInfo: PageInfo!
}

type Address {
  street: String!
  city: String!
  state: String!
  postalCode: String!
  country: String!
}

# Input types for mutations
input CreateUserInput {
  email: String!
  name: String!
  password: String!
  role: UserRole = USER
}

input UpdateUserInput {
  name: String
  avatar: String
}

input CreateProductInput {
  name: String!
  description: String!
  price: Int! # Price in cents (minor units)
  stock: Int!
  categoryId: UUID!
  images: [String!]
}

input CreateOrderInput {
  items: [OrderItemInput!]!
  shippingAddress: AddressInput!
}

input OrderItemInput {
  productId: UUID!
  quantity: Int!
}

input AddressInput {
  street: String!
  city: String!
  state: String!
  postalCode: String!
  country: String!
}

input CreateReviewInput {
  productId: UUID!
  rating: Int!
  comment: String
}

# Authentication types
type AuthPayload {
  token: String!
  refreshToken: String!
  user: User!
  expiresAt: DateTime!
}

input LoginInput {
  email: String!
  password: String!
}

input RefreshTokenInput {
  refreshToken: String!
}

# Queries
type Query {
  # User queries
  me: User
  user(id: UUID!): User
  users(
    first: Int
    after: String
    filter: UserFilter
  ): UserConnection!

  # Product queries
  product(id: UUID!): Product
  products(
    first: Int
    after: String
    filter: ProductFilter
    sortBy: String
    sortOrder: SortOrder
  ): ProductConnection!

  # Category queries
  category(id: UUID!): Category
  categoryBySlug(slug: String!): Category
  categories: [Category!]!

  # Order queries
  order(id: UUID!): Order
  orders(
    first: Int
    after: String
    filter: OrderFilter
  ): OrderConnection!

  # Search
  search(query: String!, limit: Int = 10): SearchResult!
}

type SearchResult {
  products: [Product!]!
  categories: [Category!]!
  users: [User!]!
}

# Mutations
type Mutation {
  # Auth mutations
  login(input: LoginInput!): AuthPayload!
  refreshToken(input: RefreshTokenInput!): AuthPayload!
  logout: Boolean!

  # User mutations
  createUser(input: CreateUserInput!): User!
  updateUser(id: UUID!, input: UpdateUserInput!): User!
  deleteUser(id: UUID!): Boolean!

  # Product mutations
  createProduct(input: CreateProductInput!): Product!
  updateProduct(id: UUID!, input: CreateProductInput!): Product!
  deleteProduct(id: UUID!): Boolean!

  # Order mutations
  createOrder(input: CreateOrderInput!): Order!
  updateOrderStatus(id: UUID!, status: OrderStatus!): Order!
  cancelOrder(id: UUID!): Order!

  # Review mutations
  createReview(input: CreateReviewInput!): Review!
  deleteReview(id: UUID!): Boolean!
}

# Subscriptions
type Subscription {
  orderStatusChanged(orderId: UUID!): Order!
  newOrder: Order!
  productStockUpdated(productId: UUID!): Product!
}
```

### Junior -> FAANG: Schema Design Habits That Will Save You Later

GraphQL schema design feels straightforward until you have clients that depend on it and you need to change it. The habits that prevent future pain:

Use Relay-style cursor pagination (`edges`, `node`, `cursor`, `pageInfo`) from the start, even if you are only building for one client. Offset-based pagination (`page`, `limit`) breaks when records are inserted or deleted between pages. Cursor pagination is stable. Changing pagination style later is a breaking schema change that requires coordination with every client.

Make non-null (`!`) decisions deliberately. A field marked `String!` that your service occasionally returns `null` will cause the GraphQL runtime to null-bubble up through the response, potentially nullifying an entire parent object. If a field can be absent, mark it nullable. If a field is always present for a valid object, mark it non-null. Do not default to non-null to make queries feel cleaner.

Use custom scalars for semantic types. `String` for an email address and `String` for a UUID are both strings, but they have different validation and formatting rules. Custom scalars like `Email` and `UUID` make these distinctions visible in the schema and enable client-side code generation to produce properly typed fields.

The `input` type pattern: never reuse object types as mutation inputs. Object types often contain computed or server-managed fields (`createdAt`, `id`, `averageRating`) that clients must not supply. Input types expose only the fields that are client-controlled for a given operation.

### Senior @ FAANG: Schema as a Multi-Team Contract

At staff level, schema design is a governance problem as much as a technical one. The SDL file is a contract between the backend team and every client team. Changing it has coordination costs that scale with the number of consumers.

**Breaking vs non-breaking changes.** This taxonomy must be documented and enforced in CI:

Non-breaking additions: new optional fields, new types, new optional arguments with defaults, new enum values (with caveats for exhaustive switch statements in clients).

Breaking changes: removing or renaming a field, changing a field from nullable to non-null, changing an argument type, removing an enum value, changing a scalar type.

The deprecation workflow: mark the field `@deprecated(reason: "use newField instead")`, measure its usage via field-level analytics for 90 days, remove it only when usage has dropped to zero. Never remove a field because you think it is unused. Always verify with data.

**Schema design for federation.** When the graph is federated across subgraphs, schema design decisions compound. An entity type (one decorated with `@key`) must expose its key field from any subgraph that references it. If `User` is owned by the user subgraph and referenced by the order subgraph, the order subgraph must declare `User` as an external type with its key, and the gateway will resolve the full `User` object by calling the user subgraph's entity resolver. This means: entity key fields must be stable identifiers (UUIDs, not mutable slugs), and the key field must be present on the object returned by any resolver that references the entity.

**Naming conventions as platform policy.** FAANG-scale graph platforms publish naming conventions that apply to all subgraphs: field names in camelCase, type names in PascalCase, enum values in SCREAMING_SNAKE_CASE, connection types named `{Type}Connection`, edge types named `{Type}Edge`. Consistent naming enables tooling (schema linters, client code generators) to work predictably across all subgraphs. Inconsistencies force clients to handle special cases per-type, which compounds maintenance burden.

**Interface and union design.** Interfaces and unions enable polymorphic queries (`... on Product { price }`) but add complexity to resolver implementation and client code generation. Use them when the client genuinely needs to handle multiple concrete types with a common set of fields. Do not use them to avoid duplicating three fields across two unrelated types. That is what directives or shared input types are for. The cost of a union is that every client must handle the `__typename` discriminator and write fragments for each possible type. This is justified when the types are semantically polymorphic, not just structurally similar.

---
