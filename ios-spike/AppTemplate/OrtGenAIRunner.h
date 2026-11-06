// Objective-C++ bridge to the ONNX Runtime GenAI C++ API.
// NOT COMPILED OR RUN in the environment that produced it (no Mac / Xcode). The call sequence follows the usage example in
// onnxruntime-genai/src/ort_genai.h (every call also exists in the v0.19.0 header) and the official iOS sample
// onnxruntime-inference-examples/mobile/examples/phi-3/ios/LocalLLM. Header/library versions must match each other:
// use the prebuilt iOS xcframework from the onnxruntime-genai release (it ships the headers). That build has no
// constrained decoding, so a non-nil `grammar` fails there - see docs/IOS_SPIKE.md.
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface OrtGenAIResult : NSObject
@property(nonatomic, copy) NSString *text;
@property(nonatomic) NSInteger promptTokens;
@property(nonatomic) NSInteger outputTokens;
@property(nonatomic) double ttftMs;
@property(nonatomic) double totalMs;
@end

@interface OrtGenAIRunner : NSObject
/// `modelPath` is the folder containing genai_config.json (+ model.onnx, tokenizer files).
- (nullable instancetype)initWithModelPath:(NSString *)modelPath error:(NSError **)error;
/// Applies the tokenizer's chat template to system+user, optionally constrains output with a Lark grammar (llguidance).
- (nullable OrtGenAIResult *)generateWithSystem:(NSString *)system
                                           user:(NSString *)user
                                      maxTokens:(NSInteger)maxTokens
                                        grammar:(nullable NSString *)larkGrammar
                                          error:(NSError **)error;
@end

NS_ASSUME_NONNULL_END
