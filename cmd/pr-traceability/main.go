package main

import (
	"context"
	"fmt"
	"os"

	"github.com/mattlock83/pr-traceability/internal/action"
)

func main() {
	if _, err := action.Run(context.Background(), os.Getenv, os.Stdout, nil); err != nil {
		fmt.Println("::error::" + action.EscapeAnnotation(err.Error()))
		os.Exit(1)
	}
}
