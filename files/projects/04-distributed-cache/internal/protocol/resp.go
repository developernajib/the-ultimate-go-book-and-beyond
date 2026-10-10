// internal/protocol/resp.go
package protocol

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strconv"
)

var (
	ErrInvalidProtocol = errors.New("invalid RESP protocol")
	ErrInvalidLength   = errors.New("invalid length")
)

type RESPType byte

const (
	SimpleString RESPType = '+'
	Error        RESPType = '-'
	Integer      RESPType = ':'
	BulkString   RESPType = '$'
	Array        RESPType = '*'
)

type Value struct {
	Type  RESPType
	Str   string
	Num   int64
	Bulk  []byte
	Array []Value
}

type Reader struct {
	reader *bufio.Reader
}

func NewReader(r io.Reader) *Reader {
	return &Reader{
		reader: bufio.NewReader(r),
	}
}

func (r *Reader) ReadValue() (*Value, error) {
	typ, err := r.reader.ReadByte()
	if err != nil {
		return nil, err
	}

	switch RESPType(typ) {
	case SimpleString:
		return r.readSimpleString()
	case Error:
		return r.readError()
	case Integer:
		return r.readInteger()
	case BulkString:
		return r.readBulkString()
	case Array:
		return r.readArray()
	default:
		return nil, fmt.Errorf("%w: unknown type %c", ErrInvalidProtocol, typ)
	}
}

func (r *Reader) readSimpleString() (*Value, error) {
	line, err := r.readLine()
	if err != nil {
		return nil, err
	}
	return &Value{Type: SimpleString, Str: string(line)}, nil
}

func (r *Reader) readError() (*Value, error) {
	line, err := r.readLine()
	if err != nil {
		return nil, err
	}
	return &Value{Type: Error, Str: string(line)}, nil
}

func (r *Reader) readInteger() (*Value, error) {
	line, err := r.readLine()
	if err != nil {
		return nil, err
	}
	num, err := strconv.ParseInt(string(line), 10, 64)
	if err != nil {
		return nil, err
	}
	return &Value{Type: Integer, Num: num}, nil
}

func (r *Reader) readBulkString() (*Value, error) {
	line, err := r.readLine()
	if err != nil {
		return nil, err
	}

	length, err := strconv.Atoi(string(line))
	if err != nil {
		return nil, err
	}

	// Null bulk string
	if length == -1 {
		return &Value{Type: BulkString, Bulk: nil}, nil
	}

	if length < 0 {
		return nil, ErrInvalidLength
	}

	bulk := make([]byte, length+2) // +2 for \r\n
	_, err = io.ReadFull(r.reader, bulk)
	if err != nil {
		return nil, err
	}

	return &Value{Type: BulkString, Bulk: bulk[:length]}, nil
}

func (r *Reader) readArray() (*Value, error) {
	line, err := r.readLine()
	if err != nil {
		return nil, err
	}

	length, err := strconv.Atoi(string(line))
	if err != nil {
		return nil, err
	}

	// Null array
	if length == -1 {
		return &Value{Type: Array, Array: nil}, nil
	}

	if length < 0 {
		return nil, ErrInvalidLength
	}

	array := make([]Value, length)
	for i := range length {
		val, err := r.ReadValue()
		if err != nil {
			return nil, err
		}
		array[i] = *val
	}

	return &Value{Type: Array, Array: array}, nil
}

func (r *Reader) readLine() ([]byte, error) {
	line, err := r.reader.ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	if len(line) < 2 || line[len(line)-2] != '\r' {
		return nil, ErrInvalidProtocol
	}
	return line[:len(line)-2], nil
}
