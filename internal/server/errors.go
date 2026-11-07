package server

// An expected input error must not hide a joined cleanup or close failure.
// Inspect every leaf before choosing a nonfatal HTTP response.
func allCausesMatch(err error, match func(error) bool) bool {
	if err == nil {
		return false
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		found := false
		for _, cause := range joined.Unwrap() {
			if cause == nil {
				continue
			}
			found = true
			if !allCausesMatch(cause, match) {
				return false
			}
		}
		return found
	}
	if wrapped, ok := err.(interface{ Unwrap() error }); ok {
		return allCausesMatch(wrapped.Unwrap(), match)
	}
	return match(err)
}
