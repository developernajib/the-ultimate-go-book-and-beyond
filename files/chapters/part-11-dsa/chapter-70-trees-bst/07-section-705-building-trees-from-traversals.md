## 70.5 Building Trees from Traversals

Two traversal sequences together uniquely identify a binary tree when one is the inorder traversal: the first element of preorder (or last of postorder) identifies the root, and a hash map of inorder positions splits the remaining elements into left and right subtrees in O(1) per node. Converting a sorted array to a balanced BST always selects the midpoint as the root to minimize height, mirroring the binary search halving pattern.

```go
// BuildTreeFromPreorderInorder constructs tree from preorder and inorder
// LeetCode 105: Construct Binary Tree from Preorder and Inorder Traversal
// Time: O(n), Space: O(n)
func BuildTreeFromPreorderInorder(preorder []int, inorder []int) *TreeNode {
    // Build index map for inorder
    inorderIndex := make(map[int]int)
    for i, val := range inorder {
        inorderIndex[val] = i
    }

    preorderIdx := 0

    var build func(left, right int) *TreeNode
    build = func(left, right int) *TreeNode {
        if left > right {
            return nil
        }

        // Root is next element in preorder
        rootVal := preorder[preorderIdx]
        preorderIdx++

        root := &TreeNode{Val: rootVal}

        // Find root in inorder to split left/right subtrees
        rootIndex := inorderIndex[rootVal]

        root.Left = build(left, rootIndex-1)
        root.Right = build(rootIndex+1, right)

        return root
    }

    return build(0, len(inorder)-1)
}

// BuildTreeFromInorderPostorder constructs tree from inorder and postorder
// LeetCode 106: Construct Binary Tree from Inorder and Postorder Traversal
func BuildTreeFromInorderPostorder(inorder []int, postorder []int) *TreeNode {
    inorderIndex := make(map[int]int)
    for i, val := range inorder {
        inorderIndex[val] = i
    }

    postorderIdx := len(postorder) - 1

    var build func(left, right int) *TreeNode
    build = func(left, right int) *TreeNode {
        if left > right {
            return nil
        }

        rootVal := postorder[postorderIdx]
        postorderIdx--

        root := &TreeNode{Val: rootVal}
        rootIndex := inorderIndex[rootVal]

        // Build right subtree first (postorder: left, right, root)
        root.Right = build(rootIndex+1, right)
        root.Left = build(left, rootIndex-1)

        return root
    }

    return build(0, len(inorder)-1)
}

// SortedArrayToBST converts sorted array to height-balanced BST
// LeetCode 108: Convert Sorted Array to Binary Search Tree
func SortedArrayToBST(nums []int) *TreeNode {
    return sortedArrayToBSTHelper(nums, 0, len(nums)-1)
}

func sortedArrayToBSTHelper(nums []int, left, right int) *TreeNode {
    if left > right {
        return nil
    }

    mid := left + (right-left)/2
    root := &TreeNode{Val: nums[mid]}
    root.Left = sortedArrayToBSTHelper(nums, left, mid-1)
    root.Right = sortedArrayToBSTHelper(nums, mid+1, right)

    return root
}

// SortedListToBST converts sorted linked list to BST
// LeetCode 109: Convert Sorted List to Binary Search Tree
func SortedListToBST(head *ListNode) *TreeNode {
    if head == nil {
        return nil
    }

    // Find middle using fast-slow pointer
    var prev *ListNode
    slow, fast := head, head

    for fast != nil && fast.Next != nil {
        prev = slow
        slow = slow.Next
        fast = fast.Next.Next
    }

    root := &TreeNode{Val: slow.Val}

    if prev != nil {
        prev.Next = nil
        root.Left = SortedListToBST(head)
    }

    root.Right = SortedListToBST(slow.Next)

    return root
}

type ListNode struct {
    Val  int
    Next *ListNode
}
```

### Junior -> FAANG: Tree Reconstruction as Interview Pattern

Building a tree from traversal sequences is a common Medium-to-Hard interview problem. The key insight for preorder+inorder reconstruction (LC 105): the first element of preorder is always the root - its position in the inorder array divides the tree into left and right subtrees - the number of elements to the left of the root in inorder equals the size of the left subtree, which determines how many elements from preorder belong to the left subtree.

The hash map of inorder positions (`inorderIndex`) is the optimization that takes the solution from O(n²) (linear search for root in inorder at every level) to O(n) (O(1) lookup). Never implement the O(n²) version in an interview without mentioning the O(n) optimization.

SortedArrayToBST (LC 108) is the canonical example of "always pick the midpoint as root to minimize height." The midpoint formula `mid = left + (right-left)/2` avoids integer overflow (use this form, not `(left+right)/2`). This exact pattern also appears in constructing a balanced BST from sorted data during a balance restoration operation.

### Senior @ FAANG: Tree Reconstruction in Production Contexts

The preorder+inorder reconstruction algorithm is the foundation for XML/HTML parse tree reconstruction, AST deserialization in language servers, and any system that stores a tree as a flat traversal sequence rather than an explicit node structure.

A production consideration the algorithm ignores: duplicate values. The algorithm as shown assumes all values are distinct. If duplicates exist, the inorder index map would map each value to only one position, causing incorrect splits. Real AST parsers handle this by using node IDs rather than values as keys, ensuring uniqueness even when node values repeat.

The SortedListToBST algorithm (LC 109) using slow/fast pointer to find the midpoint is O(n log n) overall: O(n) for the midpoint traversal at each level, multiplied by O(log n) levels. For a sorted array, the O(n) approach (index into the array) is faster. This asymptotic difference matters at scale: on a very large sorted list the O(n log n) approach re-walks pointers at every level, while copying the list into a slice once and then using the O(n) index-based construction trades one linear pass and O(n) memory for the entire log factor. The cache behavior compounds the win, since the array version walks contiguous memory while the list version chases pointers across the heap. Recognizing this tradeoff, and knowing when the extra allocation is worth it, is a senior-level judgment call.
