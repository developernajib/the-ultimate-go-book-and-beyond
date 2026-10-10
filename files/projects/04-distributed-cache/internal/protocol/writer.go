// internal/protocol/writer.go
package protocol

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
)

type Writer struct {
	writer *bufio.Writer
}

func NewWriter(w io.Writer) *Writer {
	return &Writer{
		writer: bufio.NewWriter(w),
	}
}

func (w *Writer) WriteValue(v *Value) error {
	switch v.Type {
	case SimpleString:
		return w.WriteSimpleString(v.Str)
	case Error:
		return w.WriteError(v.Str)
	case Integer:
		return w.WriteInteger(v.Num)
	case BulkString:
		return w.WriteBulkString(v.Bulk)
	case Array:
		return w.WriteArray(v.Array)
	default:
		return fmt.Errorf("unknown value type: %c", v.Type)
	}
}

func (w *Writer) WriteSimpleString(s string) error {
	w.writer.WriteByte(byte(SimpleString))
	w.writer.WriteString(s)
	w.writer.WriteString("\r\n")
	return w.writer.Flush()
}

func (w *Writer) WriteError(s string) error {
	w.writer.WriteByte(byte(Error))
	w.writer.WriteString(s)
	w.writer.WriteString("\r\n")
	return w.writer.Flush()
}

func (w *Writer) WriteInteger(n int64) error {
	w.writer.WriteByte(byte(Integer))
	w.writer.WriteString(strconv.FormatInt(n, 10))
	w.writer.WriteString("\r\n")
	return w.writer.Flush()
}

func (w *Writer) WriteBulkString(b []byte) error {
	if b == nil {
		w.writer.WriteString("$-1\r\n")
		return w.writer.Flush()
	}

	w.writer.WriteByte(byte(BulkString))
	w.writer.WriteString(strconv.Itoa(len(b)))
	w.writer.WriteString("\r\n")
	w.writer.Write(b)
	w.writer.WriteString("\r\n")
	return w.writer.Flush()
}

func (w *Writer) WriteArray(arr []Value) error {
	if arr == nil {
		w.writer.WriteString("*-1\r\n")
		return w.writer.Flush()
	}

	w.writer.WriteByte(byte(Array))
	w.writer.WriteString(strconv.Itoa(len(arr)))
	w.writer.WriteString("\r\n")

	for _, v := range arr {
		if err := w.WriteValue(&v); err != nil {
			return err
		}
	}

	return nil
}

func (w *Writer) WriteOK() error {
	return w.WriteSimpleString("OK")
}

func (w *Writer) WriteNull() error {
	return w.WriteBulkString(nil)
}
