package com.example;

import org.junit.jupiter.api.Test;

// Hand-written fixture: test sources are KEEP at most, never SAFE.
public class BasicServiceTest {
  @Test
  public void testLive() {
    BasicService service = new BasicService();
    int result = service.live();
    System.out.println(result);
  }

  private void testHelper() {
  }
}
